import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import { Pool } from 'pg';

import { parseEnrollmentPacket } from '../src/cli/local-device-store';
import { generateTotp, isValidTotpSecret, verifyTotp } from '../src/domain/payment-engine/totp';
import { createApp } from '../src/app';
import { createDataEncryption } from '../src/services/data-encryption';
import { base32Encode, deviceSecretContext } from '../src/services/totp-enrollment';

/* These tests need a migrated Postgres: TEST_DATABASE_URL=... npm test */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the database tests';

const encryptionKey = randomBytes(32).toString('base64');

test('base32Encode produces canonical secrets the domain module accepts', () => {
  for (let i = 0; i < 200; i += 1) {
    const secret = base32Encode(randomBytes(20));
    assert.equal(secret.length, 32);
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(isValidTotpSecret(secret, 20), true);
  }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
});

async function fixture(t: TestContext) {
  const { app, close } = createApp({
    databaseUrl,
    jwtSecret: randomBytes(32).toString('hex'),
    dataEncryptionKey: encryptionKey,
  });
  const server = app.listen(0, '127.0.0.1');
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await close();
    await pool.end();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const call = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });

  async function registerUser() {
    const res = await call('/api/auth/register', {
      method: 'POST',
      json: { name: 'Test User', email: `${randomUUID()}@example.com`, password: 'a-long-test-password' },
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { token?: string; accessToken?: string; user: { id: number } };
    const token = body.token ?? body.accessToken;
    assert(token, 'register should return a bearer token');
    return { token, userId: body.user.id };
  }

  async function insertGrant(userId: number, overrides: { status?: string; validFrom?: string; validUntil?: string } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO app_private.payment_grants
         (payer_user_id, payer_wallet_address, authority_source, status, asset_code, asset_scale,
          cumulative_cap, per_payment_max_debit, valid_from, valid_until)
       VALUES ($1, '$ilp.example/payer', 'DEMO_PLACEHOLDER', $2, 'ZAR', 2, 50000, 5000,
               COALESCE($3::timestamptz, now() - interval '1 minute'),
               COALESCE($4::timestamptz, now() + interval '30 days'))
       RETURNING id`,
      [userId, overrides.status ?? 'ACTIVE', overrides.validFrom ?? null, overrides.validUntil ?? null],
    );
    return rows[0].id as string;
  }

  const enroll = (token: string | undefined, json: unknown) =>
    call('/api/devices/totp/enroll', { method: 'POST', token, json });

  return { call, pool, registerUser, insertGrant, enroll };
}

test('enrollment requires a login', { skip }, async (t) => {
  const { enroll } = await fixture(t);
  const res = await enroll(undefined, { authorizationId: randomUUID(), deviceName: 'PC' });
  assert.equal(res.status, 401);
});

test('enrollment returns the exact packet the offline client accepts, stores only ciphertext', { skip }, async (t) => {
  const { registerUser, insertGrant, enroll, pool } = await fixture(t);
  const { token, userId } = await registerUser();
  const grantId = await insertGrant(userId);

  const res = await enroll(token, { authorizationId: grantId, deviceName: 'Demo PC' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  const packet = JSON.parse(text);

  assert.deepEqual(Object.keys(packet).sort(), [
    'algorithm', 'digits', 'expiresAtEpochMs', 'periodSeconds', 'prefix', 'revoked', 'secret', 'version',
  ]);
  assert.match(packet.prefix, /^[A-Z0-9]{4,12}$/);
  assert.notEqual(packet.prefix, '4RTW');
  /* the real offline-client parser accepts it unchanged */
  const profile = parseEnrollmentPacket(text, Date.now());
  assert.equal(profile.prefix, packet.prefix);

  /* the stored value is ciphertext, and the backend can read it back */
  const { rows } = await pool.query(
    'SELECT id, secret_ciphertext, key_version, status FROM app_private.totp_devices WHERE prefix = $1',
    [packet.prefix],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ACTIVE');
  assert.equal((rows[0].secret_ciphertext as Buffer).includes(Buffer.from(packet.secret)), false);
  const enc = createDataEncryption(new Map([[1, Buffer.from(encryptionKey, 'base64')]]), 1);
  const stored = enc.decrypt(
    { ciphertext: rows[0].secret_ciphertext, keyVersion: rows[0].key_version },
    deviceSecretContext(rows[0].id),
  );
  assert.equal(stored, packet.secret);

  /* a code from the client's secret verifies against the stored secret */
  const now = Date.now();
  const { code } = generateTotp(packet.secret, now);
  assert.equal(verifyTotp(stored, code, now, 0).valid, true);
});

test('a second enrollment for the same grant is refused until the first is revoked', { skip }, async (t) => {
  const { registerUser, insertGrant, enroll, call } = await fixture(t);
  const { token, userId } = await registerUser();
  const grantId = await insertGrant(userId);

  const first = await enroll(token, { authorizationId: grantId, deviceName: 'PC' });
  assert.equal(first.status, 201);
  const { prefix } = (await first.json()) as { prefix: string };

  const retry = await enroll(token, { authorizationId: grantId, deviceName: 'PC' });
  assert.equal(retry.status, 409);
  assert.equal('secret' in ((await retry.json()) as object), false);

  const revoked = await call(`/api/devices/totp/${prefix}/revoke`, { method: 'POST', token });
  assert.equal(revoked.status, 200);
  assert.equal(((await revoked.json()) as { status: string }).status, 'REVOKED');
  /* revoking again changes nothing */
  assert.equal((await call(`/api/devices/totp/${prefix}/revoke`, { method: 'POST', token })).status, 200);

  const again = await enroll(token, { authorizationId: grantId, deviceName: 'PC' });
  assert.equal(again.status, 201);
  assert.notEqual(((await again.json()) as { prefix: string }).prefix, prefix);
});

test('another user cannot enroll against, read or revoke someone else\'s grant or device', { skip }, async (t) => {
  const { registerUser, insertGrant, enroll, call } = await fixture(t);
  const owner = await registerUser();
  const intruder = await registerUser();
  const grantId = await insertGrant(owner.userId);

  assert.equal((await enroll(intruder.token, { authorizationId: grantId, deviceName: 'PC' })).status, 404);

  const ok = await enroll(owner.token, { authorizationId: grantId, deviceName: 'PC' });
  const { prefix } = (await ok.json()) as { prefix: string };
  assert.equal((await call(`/api/devices/totp/${prefix}/status`, { token: intruder.token })).status, 404);
  assert.equal((await call(`/api/devices/totp/${prefix}/revoke`, { method: 'POST', token: intruder.token })).status, 404);
  const stillActive = await call(`/api/devices/totp/${prefix}/status`, { token: owner.token });
  assert.equal(((await stillActive.json()) as { status: string }).status, 'ACTIVE');
});

test('status never returns the secret', { skip }, async (t) => {
  const { registerUser, insertGrant, enroll, call } = await fixture(t);
  const { token, userId } = await registerUser();
  const grantId = await insertGrant(userId);
  const packet = (await (await enroll(token, { authorizationId: grantId, deviceName: 'PC' })).json()) as {
    prefix: string; secret: string;
  };
  const res = await call(`/api/devices/totp/${packet.prefix}/status`, { token });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(text.includes(packet.secret), false);
  assert.equal('secret' in JSON.parse(text), false);
});

test('unusable grants (revoked, expired, not yet valid) and bad input are rejected', { skip }, async (t) => {
  const { registerUser, insertGrant, enroll } = await fixture(t);
  const { token, userId } = await registerUser();

  for (const overrides of [
    { status: 'REVOKED' },
    { validFrom: '2020-01-01', validUntil: '2020-02-01' },
    { validFrom: '2099-01-01', validUntil: '2099-02-01' },
  ]) {
    const grantId = await insertGrant(userId, overrides);
    assert.equal((await enroll(token, { authorizationId: grantId, deviceName: 'PC' })).status, 409);
  }

  const grantId = await insertGrant(userId);
  assert.equal((await enroll(token, { authorizationId: 'not-a-uuid', deviceName: 'PC' })).status, 400);
  assert.equal((await enroll(token, { authorizationId: grantId, deviceName: '' })).status, 400);
  assert.equal((await enroll(token, { authorizationId: grantId, deviceName: 'x'.repeat(61) })).status, 400);
  assert.equal((await enroll(token, { authorizationId: grantId })).status, 400);
  assert.equal((await enroll(token, null)).status, 400);
  assert.equal((await enroll(token, { authorizationId: randomUUID(), deviceName: 'PC' })).status, 404);
});

test('without an encryption key, device enrollment is unavailable rather than insecure', { skip }, async (t) => {
  const { app, close } = createApp({ databaseUrl, jwtSecret: randomBytes(32).toString('hex') });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const res = await fetch(`http://127.0.0.1:${address.port}/api/devices/totp/enroll`, { method: 'POST' });
  assert.equal(res.status, 503);
});
