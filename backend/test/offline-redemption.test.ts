import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  cancels = 0;
  completedIncoming: string[] = [];
  /* server-side approval script */
  grantStarts: { finishUri: string; clientNonce: string; debitLimit: Money }[] = [];
  grantFinishes = 0;
  finishBehaviour: 'ok' | 'fail' | 'small' = 'ok';
  /* what findOutgoingByQuote reports: 'found' = provider did create it */
  lookup: 'found' | 'missing' | 'error' = 'missing';
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
  async findOutgoingByQuote(args: { quoteId: string }) {
    if (this.lookup === 'error') throw new ProviderUnknownError('down');
    return this.lookup === 'found' ? { outgoingPaymentId: `${args.quoteId}/outgoing` } : undefined;
  }
  async cancelGrant() {
    this.cancels += 1;
  }
  async completeIncoming(args: { incomingPaymentId: string }) {
    this.completedIncoming.push(args.incomingPaymentId);
  }
  async lookupWallet(address: string) {
    if (address.includes('missing')) throw new Error('no such wallet');
    return { id: 'https://ilp.interledger-test.dev/payer', assetCode: 'EUR', assetScale: 2, authServer: 'https://auth.interledger-test.dev/' };
  }
  async startOutgoingGrant(args: { finishUri: string; clientNonce: string; debitLimit: Money }) {
    this.grantStarts.push(args);
    return {
      redirectUrl: 'https://auth.interledger-test.dev/interact/abc',
      providerNonce: 'provider-nonce-123',
      grantRequestUrl: 'https://auth.interledger-test.dev/',
      continuation: { uri: 'https://auth.interledger-test.dev/continue/abc', accessToken: 'cont-1' },
    };
  }
  async finishOutgoingGrant(args: { requestedDebit: Money }) {
    this.grantFinishes += 1;
    if (this.finishBehaviour === 'fail') throw new ProviderUnknownError('nope');
    return {
      authority: { accessToken: 'approved-token', manageUrl: 'https://auth.interledger-test.dev/manage/x', expiresAtEpochMs: Date.now() + 600_000 },
      continuation: { uri: 'https://auth.interledger-test.dev/continue/final', accessToken: 'cont-final' },
      grantedDebit: this.finishBehaviour === 'small' ? { ...args.requestedDebit, value: '100' } : args.requestedDebit,
    };
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
  const { app, close, reconcilePayments } = createApp({
    databaseUrl,
    jwtSecret: randomBytes(32).toString('hex'),
    dataEncryptionKey: keyB64,
    redemptionProvider: provider,
    confirmTimeoutMs: 0,
    confirmPollMs: 1,
    publicBaseUrl: 'https://api.example.test',
    log: () => {},
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
    await store.saveContinuation(pool, grantId, { uri: 'https://auth.interledger-test.dev/continue/1', accessToken: 'cont-token' });
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

  return { call, pool, provider, register, payerWithDevice, merchant, redeem, reconcilePayments, base };
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
  /* receipt fields come from the provider's confirmation */
  const receipt = body as unknown as { merchantName: string; payerDebitPaid: Money; merchantReceivePaid: Money; completedAt: string };
  assert.equal(receipt.merchantName, 'Spaza');
  assert.deepEqual(receipt.payerDebitPaid, ZAR('186'));
  assert.deepEqual(receipt.merchantReceivePaid, EUR('10'));
  assert.ok(Date.parse(receipt.completedAt) > 0);
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
  /* the merchant's unpaid incoming payment is closed instead of left to expire */
  assert.equal(f.provider.completedIncoming.length, 1);
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

async function fresh(f: Awaited<ReturnType<typeof fixture>>, where: string) {
  /* helper: read an attempt row directly */
  return (await f.pool.query(`SELECT status, error_code FROM app_private.payment_attempts WHERE ${where}`)).rows;
}

test('both parties see the payment in their receipt list', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  const { paymentId } = (await (await f.redeem(shop.token, payer.code())).json()) as { paymentId: string };

  const mine = (await (await f.call('/api/payments', { token: payer.token })).json()) as {
    asPayer: { paymentId: string }[]; asMerchant: unknown[];
  };
  assert.deepEqual(mine.asPayer.map((p) => p.paymentId), [paymentId]);
  assert.equal(mine.asMerchant.length, 0);
  const theirs = (await (await f.call('/api/payments', { token: shop.token })).json()) as {
    asPayer: unknown[]; asMerchant: { paymentId: string }[];
  };
  assert.deepEqual(theirs.asMerchant.map((p) => p.paymentId), [paymentId]);
});

test('revoking a grant blocks new debits immediately and cancels it at the provider', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();

  const view = await f.call(`/api/payment-grants/${payer.grantId}`, { token: payer.token });
  assert.equal(view.status, 200);
  const before = (await view.json()) as { status: string; remaining: Money };
  assert.equal(before.status, 'ACTIVE');
  assert.deepEqual(before.remaining, ZAR('50000'));

  const res = await f.call(`/api/payment-grants/${payer.grantId}`, { method: 'DELETE', token: payer.token });
  assert.equal(res.status, 200);
  const after = (await res.json()) as { status: string; providerRevocation: string };
  assert.equal(after.status, 'REVOKED');
  assert.equal(after.providerRevocation, 'CONFIRMED');
  assert.equal(f.provider.cancels, 1);

  const attempt = await f.redeem(shop.token, payer.code());
  assert.ok([409, 422].includes(attempt.status), `got ${attempt.status}`);
  assert.equal(f.provider.submits.length, 0);

  /* revoking twice is harmless and doesn't call the provider again */
  assert.equal((await f.call(`/api/payment-grants/${payer.grantId}`, { method: 'DELETE', token: payer.token })).status, 200);
  assert.equal(f.provider.cancels, 1);
});

test('nobody else can read or revoke a grant', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const other = await f.register();
  assert.equal((await f.call(`/api/payment-grants/${payer.grantId}`, { token: other.token })).status, 404);
  assert.equal((await f.call(`/api/payment-grants/${payer.grantId}`, { method: 'DELETE', token: other.token })).status, 404);
  const still = (await (await f.call(`/api/payment-grants/${payer.grantId}`, { token: payer.token })).json()) as { status: string };
  assert.equal(still.status, 'ACTIVE');
});

test('an expired grant cannot be debited', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  await f.pool.query(
    "UPDATE app_private.payment_grants SET valid_from = now() - interval '2 days', valid_until = now() - interval '1 second' WHERE id = $1",
    [payer.grantId],
  );
  const res = await f.redeem(shop.token, payer.code());
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'GRANT_NOT_SPENDABLE');
  assert.equal(f.provider.submits.length, 0);
});

test('provider cancellation is deferred while a payment is unresolved, then completes', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.submitBehaviour = 'unknown';
  const { paymentId } = (await (await f.redeem(shop.token, payer.code())).json()) as { paymentId: string };

  const revoked = (await (await f.call(`/api/payment-grants/${payer.grantId}`, { method: 'DELETE', token: payer.token })).json()) as {
    status: string; providerRevocation: string;
  };
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(revoked.providerRevocation, 'DEFERRED_UNRESOLVED_PAYMENTS');
  assert.equal(f.provider.cancels, 0);

  /* the provider did create it: recovery finds it and confirms */
  f.provider.lookup = 'found';
  await f.reconcilePayments();
  assert.equal((await fresh(f, `id = '${paymentId}'`))[0].status, 'SUCCEEDED');

  const again = (await (await f.call(`/api/payment-grants/${payer.grantId}`, { method: 'DELETE', token: payer.token })).json()) as {
    providerRevocation: string;
  };
  assert.equal(again.providerRevocation, 'CONFIRMED');
  assert.equal(f.provider.cancels, 1);
});

test('crash recovery: an unclear submit that did reach the provider is found and settled once', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.submitBehaviour = 'unknown';
  const { paymentId, status } = (await (await f.redeem(shop.token, payer.code())).json()) as { paymentId: string; status: string };
  assert.equal(status, 'UNKNOWN');

  /* provider unreachable: stays UNKNOWN, budget held */
  f.provider.lookup = 'error';
  await f.reconcilePayments();
  assert.equal((await fresh(f, `id = '${paymentId}'`))[0].status, 'UNKNOWN');

  f.provider.lookup = 'found';
  await f.reconcilePayments();
  await f.reconcilePayments();
  assert.equal((await fresh(f, `id = '${paymentId}'`))[0].status, 'SUCCEEDED');
  const grant = await f.pool.query('SELECT cumulative_spent FROM app_private.payment_grants WHERE id = $1', [payer.grantId]);
  assert.equal(grant.rows[0].cumulative_spent, '186');
  assert.equal(f.provider.submits.length, 1);
});

test('crash recovery: a process that died mid-submit leaves no double debit', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.payerWithDevice();
  const shop = await f.merchant();
  f.provider.outcome = { kind: 'PENDING' };
  const { paymentId } = (await (await f.redeem(shop.token, payer.code())).json()) as { paymentId: string };

  /* simulate a crash right after "SUBMITTING" was saved, before the provider answered */
  await f.pool.query(
    `UPDATE app_private.payment_attempts SET status = 'SUBMITTING', provider_attempt_ref = NULL,
       updated_at = now() - interval '10 minutes' WHERE id = $1`,
    [paymentId],
  );
  /* provider has no such payment: first pass marks UNKNOWN and holds the budget */
  f.provider.lookup = 'missing';
  await f.reconcilePayments();
  assert.equal((await fresh(f, `id = '${paymentId}'`))[0].status, 'UNKNOWN');

  /* still missing well after the fact: it was never submitted, so the hold is released */
  await f.pool.query("UPDATE app_private.payment_attempts SET updated_at = now() - interval '10 minutes' WHERE id = $1", [paymentId]);
  await f.reconcilePayments();
  const [row] = await fresh(f, `id = '${paymentId}'`);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.error_code, 'NOT_SUBMITTED');
  const held = await f.pool.query(
    "SELECT state FROM app_private.spending_reservations WHERE grant_id = $1", [payer.grantId],
  );
  assert.deepEqual(held.rows.map((r) => r.state), ['RELEASED']);
  assert.equal(f.provider.submits.length, 1);
});

/* ---------- server-side grant approval ---------- */

function gnapHash(clientNonce: string, providerNonce: string, interactRef: string, grantUrl: string): string {
  return createHash('sha256').update([clientNonce, providerNonce, interactRef, grantUrl].join('\n'), 'ascii').digest('base64');
}

async function startApproval(f: Awaited<ReturnType<typeof fixture>>, token: string, body: unknown = { walletAddress: '$ilp.interledger-test.dev/payer' }) {
  const res = await f.call('/api/payment-grants', { method: 'POST', token, json: body });
  return res;
}

test('server-side approval: start, verified callback, grant stored and usable for enrollment', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.register();
  const res = await startApproval(f, payer.token, { walletAddress: '$ilp.interledger-test.dev/payer', cumulativeCap: '20000', perPaymentMaxDebit: '1000' });
  assert.equal(res.status, 202);
  const started = (await res.json()) as { approvalId: string; authorizationUrl: string; status: string; cumulativeCap: Money };
  assert.equal(started.status, 'AWAITING_APPROVAL');
  assert.equal(started.authorizationUrl, 'https://auth.interledger-test.dev/interact/abc');
  assert.deepEqual(started.cumulativeCap, EUR('20000'));
  const { finishUri, clientNonce } = f.provider.grantStarts[0];
  assert.equal(finishUri, `https://api.example.test/api/open-payments/callback/${started.approvalId}`);

  /* nonces/continuation are not stored in plaintext */
  const stored = await f.pool.query('SELECT secrets_ciphertext FROM app_private.provider_interactions WHERE id = $1', [started.approvalId]);
  assert.equal((stored.rows[0].secrets_ciphertext as Buffer).includes(Buffer.from(clientNonce)), false);

  const hash = gnapHash(clientNonce, 'provider-nonce-123', 'ref-1', 'https://auth.interledger-test.dev/');
  const cb = await fetch(`${f.base}/api/open-payments/callback/${started.approvalId}?interact_ref=ref-1&hash=${encodeURIComponent(hash)}`);
  assert.equal(cb.status, 200);
  assert.equal(cb.headers.get('cache-control'), 'no-store');
  assert.match(await cb.text(), /Approved/);

  const status = (await (await f.call(`/api/payment-grants/approvals/${started.approvalId}`, { token: payer.token })).json()) as {
    status: string; authorizationId: string;
  };
  assert.equal(status.status, 'APPROVED');
  const grant = (await (await f.call(`/api/payment-grants/${status.authorizationId}`, { token: payer.token })).json()) as {
    status: string; authoritySource: string; perPaymentMaxDebit: Money;
  };
  assert.equal(grant.status, 'ACTIVE');
  assert.equal(grant.authoritySource, 'PROVIDER');
  assert.deepEqual(grant.perPaymentMaxDebit, EUR('1000'));

  /* and the device can be enrolled against it */
  const enroll = await f.call('/api/devices/totp/enroll', {
    method: 'POST', token: payer.token, json: { authorizationId: status.authorizationId, deviceName: 'Phone' },
  });
  assert.equal(enroll.status, 201);

  /* replaying the callback does nothing */
  const again = await fetch(`${f.base}/api/open-payments/callback/${started.approvalId}?interact_ref=ref-1&hash=${encodeURIComponent(hash)}`);
  assert.equal(again.status, 409);
  assert.equal(f.provider.grantFinishes, 1);
});

test('a forged or garbled callback is rejected and does not consume the pending approval', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.register();
  const { approvalId } = (await (await startApproval(f, payer.token)).json()) as { approvalId: string };
  const { clientNonce } = f.provider.grantStarts[0];

  for (const qs of ['', '?interact_ref=ref-1', `?interact_ref=ref-1&hash=${encodeURIComponent(gnapHash('wrong', 'provider-nonce-123', 'ref-1', 'https://auth.interledger-test.dev/'))}`]) {
    const res = await fetch(`${f.base}/api/open-payments/callback/${approvalId}${qs}`);
    assert.equal(res.status, 400);
  }
  assert.equal(f.provider.grantFinishes, 0);
  const ok = await fetch(`${f.base}/api/open-payments/callback/${approvalId}?interact_ref=ref-1&hash=${encodeURIComponent(gnapHash(clientNonce, 'provider-nonce-123', 'ref-1', 'https://auth.interledger-test.dev/'))}`);
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${f.base}/api/open-payments/callback/${randomUUID()}`)).status, 404);
});

test('payer refusal, expiry, provider failure and an undersized grant never create a usable grant', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.register();
  const status = async (id: string) =>
    ((await (await f.call(`/api/payment-grants/approvals/${id}`, { token: payer.token })).json()) as { status: string; errorCode?: string });
  const okHash = (n: number) => gnapHash(f.provider.grantStarts[n].clientNonce, 'provider-nonce-123', 'r', 'https://auth.interledger-test.dev/');

  const denied = ((await (await startApproval(f, payer.token)).json()) as { approvalId: string }).approvalId;
  assert.equal((await fetch(`${f.base}/api/open-payments/callback/${denied}?result=grant_rejected`)).status, 400);
  assert.equal((await status(denied)).status, 'DENIED');

  const expired = ((await (await startApproval(f, payer.token)).json()) as { approvalId: string }).approvalId;
  await f.pool.query("UPDATE app_private.provider_interactions SET expires_at = now() - interval '1 second' WHERE id = $1", [expired]);
  assert.equal((await fetch(`${f.base}/api/open-payments/callback/${expired}?interact_ref=r&hash=${encodeURIComponent(okHash(1))}`)).status, 410);
  assert.equal((await status(expired)).status, 'EXPIRED');

  f.provider.finishBehaviour = 'fail';
  const failed = ((await (await startApproval(f, payer.token)).json()) as { approvalId: string }).approvalId;
  assert.equal((await fetch(`${f.base}/api/open-payments/callback/${failed}?interact_ref=r&hash=${encodeURIComponent(okHash(2))}`)).status, 502);
  assert.equal((await status(failed)).status, 'FAILED');

  f.provider.finishBehaviour = 'small';
  const small = ((await (await startApproval(f, payer.token)).json()) as { approvalId: string }).approvalId;
  assert.equal((await fetch(`${f.base}/api/open-payments/callback/${small}?interact_ref=r&hash=${encodeURIComponent(okHash(3))}`)).status, 502);
  assert.equal((await status(small)).errorCode, 'GRANT_TOO_SMALL');

  const grants = (await (await f.call('/api/payment-grants', { token: payer.token })).json()) as { grants: unknown[] };
  assert.equal(grants.grants.length, 0);
  assert.ok(f.provider.cancels >= 3, 'abandoned grants are cancelled at the provider');
});

test('approvals are private and inputs are validated', { skip }, async (t) => {
  const f = await fixture(t);
  const payer = await f.register();
  const other = await f.register();
  assert.equal((await f.call('/api/payment-grants', { method: 'POST', json: { walletAddress: 'x' } })).status, 401);
  for (const body of [{}, { walletAddress: '' }, { walletAddress: '$w', cumulativeCap: 500 }, { walletAddress: '$w', cumulativeCap: '100', perPaymentMaxDebit: '200' }, { walletAddress: '$w', cumulativeCap: '9999999' }]) {
    assert.equal((await startApproval(f, payer.token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await startApproval(f, payer.token, { walletAddress: '$ilp.interledger-test.dev/missing' })).status, 422);
  const { approvalId } = (await (await startApproval(f, payer.token)).json()) as { approvalId: string };
  assert.equal((await f.call(`/api/payment-grants/approvals/${approvalId}`, { token: other.token })).status, 404);
});
