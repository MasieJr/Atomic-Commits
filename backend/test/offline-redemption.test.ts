import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import { Pool } from 'pg';

import { formatPaymentCode, generateTotp } from '../src/domain/payment-engine/totp';
import { createApp } from '../src/app';
import { createDataEncryption } from '../src/services/data-encryption';
import { createGrantAuthorityStore } from '../src/services/grant-authority-store';
import {
  ProviderRejectedError,
  ProviderUnknownError,
  type Money,
  type OutgoingAuthority,
  type ProviderOutcome,
  type RedemptionProvider,
} from '../src/services/redemption-provider';

/* Needs a migrated Postgres: TEST_DATABASE_URL=... npm test */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the database tests';

const ZAR = (value: string): Money => ({ value, assetCode: 'ZAR', assetScale: 2 });
const EUR = (value: string): Money => ({ value, assetCode: 'EUR', assetScale: 2 });

/* scriptable fake provider that records every call */
class FakeProvider implements RedemptionProvider {
  debit = ZAR('186');
  submitBehaviour: 'ok' | 'reject' | 'unknown' = 'ok';
  outcome: ProviderOutcome = { kind: 'SUCCEEDED', sent: ZAR('186'), received: EUR('10') };
  quoteFails = false;
  rotateBehaviour: 'ok' | 'reject' | 'unknown' = 'ok';
  submits: { quoteId: string; accessToken: string }[] = [];
  reads = 0;
  rotations = 0;
  private n = 0;

  async prepareQuote() {
    if (this.quoteFails) throw new Error('quote down');
    this.n += 1;
    return {
      incomingPaymentId: `https://ilp.interledger-test.dev/incoming/${this.n}`,
      quoteId: `https://ilp.interledger-test.dev/quotes/${this.n}`,
      debit: this.debit,
      receive: EUR('10'),
    };
  }
  async submitPayment(args: { quoteId: string; authority: OutgoingAuthority }) {
    this.submits.push({ quoteId: args.quoteId, accessToken: args.authority.accessToken });
    if (this.submitBehaviour === 'reject') throw new ProviderRejectedError('no');
    if (this.submitBehaviour === 'unknown') throw new ProviderUnknownError('timeout');
    return { outgoingPaymentId: `https://ilp.interledger-test.dev/outgoing/${this.submits.length}` };
  }
  async readOutcome() {
    this.reads += 1;
    return this.outcome;
  }
  async rotateAuthority(): Promise<OutgoingAuthority> {
    this.rotations += 1;
    if (this.rotateBehaviour === 'reject') throw new ProviderRejectedError('no');
    if (this.rotateBehaviour === 'unknown') throw new ProviderUnknownError('?');
    return { accessToken: `rotated-${this.rotations}`, manageUrl: 'https://auth.interledger-test.dev/m2', expiresAtEpochMs: Date.now() + 600_000 };
  }
}

async function fixture(t: TestContext) {
  const keyB64 = randomBytes(32).toString('base64');
  const provider = new FakeProvider();
  const { app, close } = createApp({
    databaseUrl,
    jwtSecret: randomBytes(32).toString('hex'),
    dataEncryptionKey: keyB64,
    redemptionProvider: provider,
    confirmTimeoutMs: 0,
    confirmPollMs: 1,
  });
  const server = app.listen(0, '127.0.0.1');
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await close();
    await pool.end();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const store = createGrantAuthorityStore(createDataEncryption(new Map([[1, Buffer.from(keyB64, 'base64')]]), 1));

  const call = (path: string, init: { method?: string; token?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });

  async function register() {
    const res = await call('/api/auth/register', {
      method: 'POST',
      json: { name: 'Test User', email: `${randomUUID()}@example.com`, password: 'a-long-test-password' },
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { token?: string; accessToken?: string; user: { id: number } };
    return { token: (body.token ?? body.accessToken)!, userId: body.user.id };
  }

  /* payer with a PROVIDER grant (tokens stored encrypted) and an enrolled device */
  async function payerWithDevice(opts: { cap?: string; perPayment?: string; source?: string; tokenExpiresAt?: number } = {}) {
    const payer = await register();
    const { rows } = await pool.query(
      `INSERT INTO app_private.payment_grants
         (payer_user_id, payer_wallet_address, authority_source, asset_code, asset_scale,
          cumulative_cap, per_payment_max_debit, valid_from, valid_until)
       VALUES ($1, 'https://ilp.interledger-test.dev/payer', $2, 'ZAR', 2, $3, $4, now() - interval '1 minute', now() + interval '1 day')
       RETURNING id`,
      [payer.userId, opts.source ?? 'PROVIDER', opts.cap ?? '50000', opts.perPayment ?? '5000'],
    );
    const grantId = rows[0].id as string;
    await store.saveAuthority(pool, grantId, {
      accessToken: 'live-token-1',
      manageUrl: 'https://auth.interledger-test.dev/manage/1',
      expiresAtEpochMs: opts.tokenExpiresAt ?? Date.now() + 600_000,
    });
    const enroll = await call('/api/devices/totp/enroll', {
      method: 'POST',
      token: payer.token,
      json: { authorizationId: grantId, deviceName: 'Payer PC' },
    });
    assert.equal(enroll.status, 201);
    const packet = (await enroll.json()) as { prefix: string; secret: string };
    const code = () => formatPaymentCode(packet.prefix, generateTotp(packet.secret, Date.now()).code);
    return { ...payer, grantId, packet, code };
  }

  async function merchant() {
    const m = await register();
    await pool.query(
      `INSERT INTO app_private.merchants (user_id, display_name, receiving_wallet_address)
       VALUES ($1, 'Spaza', 'https://ilp.interledger-test.dev/shop')`,
      [m.userId],
    );
    return m;
  }

  const redeem = (token: string, paymentCode: string, key: string = randomUUID(), receive: Money = EUR('10')) =>
    call('/api/offline-redemptions', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': key },
      json: { credentialType: 'totp-v1', paymentCode, merchantReceive: receive },
    });

  return { call, pool, provider, register, payerWithDevice, merchant, redeem };
}

test('happy path: merchant redeems an offline code, provider confirms, spend is recorded', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();

  const res = await f.redeem(shop.token, payer.code());
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as { paymentId: string; status: string; payerDebitQuoted: Money };
  assert.equal(res.headers.get('location'), `/api/payments/${body.paymentId}`);
  assert.equal(body.status, 'SUCCEEDED');
  assert.deepEqual(body.payerDebitQuoted, ZAR('186'));
  assert.equal(f.provider.submits.length, 1);
  assert.equal(f.provider.submits[0].accessToken, 'live-token-1');

  const grant = await f.pool.query('SELECT cumulative_spent FROM app_private.payment_grants WHERE id = $1', [payer.grantId]);
  assert.equal(grant.rows[0].cumulative_spent, '186');

  /* both the payer and the merchant can read it; a stranger cannot */
  for (const token of [shop.token, payer.token]) {
    const view = await f.call(`/api/payments/${body.paymentId}`, { token });
    assert.equal(view.status, 200);
    assert.equal(((await view.json()) as { status: string }).status, 'SUCCEEDED');
  }
  const stranger = await f.register();
  assert.equal((await f.call(`/api/payments/${body.paymentId}`, { token: stranger.token })).status, 404);
});

test('the same code cannot be redeemed twice, even with a different idempotency key', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const code = payer.code();

  assert.equal((await f.redeem(shop.token, code)).status, 202);
  const second = await f.redeem(shop.token, code);
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { code: string }).code, 'CODE_ALREADY_USED');
  /* a second merchant can't use it either */
  const other = await f.merchant();
  assert.equal((await f.redeem(other.token, code)).status, 409);
  assert.equal(f.provider.submits.length, 1);
});

test('concurrent redemptions of one code submit exactly one payment', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const code = payer.code();

  const results = await Promise.all(Array.from({ length: 8 }, () => f.redeem(shop.token, code)));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 202).length, 1, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, 7);
  assert.equal(f.provider.submits.length, 1);
});

test('an identical retry returns the original payment without a second submit; a changed body is a conflict', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const code = payer.code();
  const key = randomUUID();

  const first = await f.redeem(shop.token, code, key);
  assert.equal(first.status, 202);
  const original = (await first.json()) as { paymentId: string };

  const retry = await f.redeem(shop.token, code, key);
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { paymentId: string }).paymentId, original.paymentId);

  const changed = await f.redeem(shop.token, code, key, EUR('99'));
  assert.equal(changed.status, 409);
  assert.equal(((await changed.json()) as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.provider.submits.length, 1);
});

test('customers without a merchant record cannot redeem', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const customer = await f.register();
  const res = await f.redeem(customer.token, payer.code());
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'NOT_A_MERCHANT');
  assert.equal((await f.redeem(payer.token, payer.code())).status, 403);
  assert.equal(f.provider.submits.length, 0);
});

test('wrong, unknown, malformed and revoked codes all get the same generic answer', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const real = payer.code();
  const wrongDigits = `${payer.packet.prefix}-${real.endsWith('000000') ? '111111' : '000000'}`;

  for (const code of [wrongDigits, 'ZZZZZZ-123456']) {
    const res = await f.redeem(shop.token, code);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { code: string }).code, 'CODE_INVALID');
  }
  assert.equal((await f.redeem(shop.token, 'not a code')).status, 422);

  await f.call(`/api/devices/totp/${payer.packet.prefix}/revoke`, { method: 'POST', token: payer.token });
  const revoked = await f.redeem(shop.token, payer.code());
  assert.equal(revoked.status, 422);
  assert.equal(f.provider.submits.length, 0);
});

test('a device on a demo placeholder grant can never move money', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice({ source: 'DEMO_PLACEHOLDER' });
  const shop = await f.merchant();
  const res = await f.redeem(shop.token, payer.code());
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'DEMO_GRANT');
  assert.equal(f.provider.submits.length, 0);
});

test('a quote above the per-payment limit is rejected before any submit and frees the budget', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice({ perPayment: '5000' });
  const shop = await f.merchant();
  f.provider.debit = ZAR('5001');

  const res = await f.redeem(shop.token, payer.code());
  assert.equal(res.status, 202);
  const body = (await res.json()) as { status: string; errorCode: string };
  assert.equal(body.status, 'REJECTED');
  assert.equal(body.errorCode, 'QUOTE_EXCEEDS_LIMIT');
  assert.equal(f.provider.submits.length, 0);
  const held = await f.pool.query(
    "SELECT count(*)::int AS n FROM app_private.spending_reservations WHERE grant_id = $1 AND state IN ('RESERVED','HELD_UNKNOWN')",
    [payer.grantId],
  );
  assert.equal(held.rows[0].n, 0);
});

test('the cumulative cap is enforced across payments', { skip }, async (t) => {
  const f = await fixture(t);
  /* cap R3.00, per payment R2.00, each quote debits R1.86 */
  const payer = await f.payerWithDevice({ cap: '300', perPayment: '200' });
  const shop = await f.merchant();

  const first = await f.redeem(shop.token, payer.code());
  assert.equal(((await first.json()) as { status: string }).status, 'SUCCEEDED');

  /* wait for the next 30 s time step so the code is genuinely new */
  await f.pool.query("UPDATE app_private.totp_code_claims SET created_at = now() - interval '1 hour'");
  const nextStep = (Math.floor(Date.now() / 30_000) + 1) * 30_000;
  await new Promise((r) => setTimeout(r, nextStep - Date.now() + 50));
  /* R1.14 left: reservation is min(perPayment, remaining) = 114 < quote 186 */
  const second = await f.redeem(shop.token, payer.code());
  assert.equal(second.status, 202);
  const body = (await second.json()) as { status: string; errorCode: string };
  assert.equal(body.status, 'REJECTED');
  assert.equal(body.errorCode, 'QUOTE_EXCEEDS_LIMIT');
  assert.equal(f.provider.submits.length, 1);
});

test('an unclear submit stays UNKNOWN, holds the budget, and polling never re-submits', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.submitBehaviour = 'unknown';

  const res = await f.redeem(shop.token, payer.code());
  const body = (await res.json()) as { paymentId: string; status: string };
  assert.equal(body.status, 'UNKNOWN');

  for (let i = 0; i < 3; i += 1) {
    const view = await f.call(`/api/payments/${body.paymentId}`, { token: shop.token });
    assert.equal(((await view.json()) as { status: string }).status, 'UNKNOWN');
  }
  assert.equal(f.provider.submits.length, 1);
  const held = await f.pool.query(
    "SELECT state FROM app_private.spending_reservations WHERE grant_id = $1",
    [payer.grantId],
  );
  assert.deepEqual(held.rows.map((r) => r.state), ['HELD_UNKNOWN']);
});

test('a pending payment is confirmed later by a read, which commits the spend once', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.outcome = { kind: 'PENDING' };

  const res = await f.redeem(shop.token, payer.code());
  const body = (await res.json()) as { paymentId: string; status: string };
  assert.equal(body.status, 'PROCESSING');

  f.provider.outcome = { kind: 'SUCCEEDED', sent: ZAR('186'), received: EUR('10') };
  for (let i = 0; i < 2; i += 1) {
    const view = await f.call(`/api/payments/${body.paymentId}`, { token: payer.token });
    assert.equal(((await view.json()) as { status: string }).status, 'SUCCEEDED');
  }
  const grant = await f.pool.query('SELECT cumulative_spent FROM app_private.payment_grants WHERE id = $1', [payer.grantId]);
  assert.equal(grant.rows[0].cumulative_spent, '186');
  assert.equal(f.provider.submits.length, 1);
});

test('a definite provider refusal fails the attempt and releases the budget', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.submitBehaviour = 'reject';
  const body = (await (await f.redeem(shop.token, payer.code())).json()) as { status: string; errorCode: string };
  assert.equal(body.status, 'FAILED');
  assert.equal(body.errorCode, 'PROVIDER_REJECTED');
  const held = await f.pool.query("SELECT state FROM app_private.spending_reservations WHERE grant_id = $1", [payer.grantId]);
  assert.deepEqual(held.rows.map((r) => r.state), ['RELEASED']);
});

test('an expiring access token is rotated in place before submitting; a refused rotation blocks spending', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice({ tokenExpiresAt: Date.now() + 5_000 });
  const shop = await f.merchant();

  const body = (await (await f.redeem(shop.token, payer.code())).json()) as { status: string };
  assert.equal(body.status, 'SUCCEEDED');
  assert.equal(f.provider.rotations, 1);
  assert.equal(f.provider.submits[0].accessToken, 'rotated-1');

  const other = await f.payerWithDevice({ tokenExpiresAt: Date.now() + 5_000 });
  f.provider.rotateBehaviour = 'reject';
  const failed = (await (await f.redeem(shop.token, other.code())).json()) as { status: string; errorCode: string };
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'GRANT_NOT_SPENDABLE');
  const g = await f.pool.query('SELECT status FROM app_private.payment_grants WHERE id = $1', [other.grantId]);
  assert.equal(g.rows[0].status, 'REAUTHORIZATION_REQUIRED');
  assert.equal(f.provider.submits.length, 1);
});

test('requests without an idempotency key or with a bad body are rejected', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const noKey = await f.call('/api/offline-redemptions', {
    method: 'POST',
    token: shop.token,
    json: { credentialType: 'totp-v1', paymentCode: payer.code(), merchantReceive: EUR('10') },
  });
  assert.equal(noKey.status, 400);
  assert.equal(((await noKey.json()) as { code: string }).code, 'IDEMPOTENCY_KEY_REQUIRED');

  for (const receive of [{ value: '10.5', assetCode: 'EUR', assetScale: 2 }, { value: '0', assetCode: 'EUR', assetScale: 2 }, { value: 10 }]) {
    const res = await f.redeem(shop.token, payer.code(), randomUUID(), receive as Money);
    assert.equal(res.status, 400);
  }
  assert.equal(f.provider.submits.length, 0);
});

test('payment routes require a login', { skip }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/offline-redemptions', { method: 'POST', json: {} })).status, 401);
  assert.equal((await f.call(`/api/payments/${randomUUID()}`)).status, 401);
});
