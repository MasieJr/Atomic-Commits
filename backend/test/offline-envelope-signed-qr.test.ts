import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import type { GrantAuthorization } from '../src/domain/payment-engine/grants';
import type { ClaimResult } from '../src/domain/payment-engine/ports';
import {
  offlineInstructionSigningBytes,
  parseSignedOfflineInstruction,
  verifyOfflineInstructionSignature,
  type OfflineInstructionV1,
  type SignedOfflineInstructionV1,
} from '../src/domain/payment-engine/signed-offline-instruction';
import { evaluateOfflineSpendingPolicy, type OfflinePolicyContext } from '../src/domain/payment-engine/offline-spending-policy';
import { reserveSignedOfflineInstruction, type OfflineAtomicReservationRequest, type OfflineRedemptionPorts } from '../src/domain/payment-engine/offline-redemption';

const NOW = 1_700_000_000_000;
const USD = (value: string) => ({ value, assetCode: 'USD', assetScale: 2 });
const EUR = (value: string) => ({ value, assetCode: 'EUR', assetScale: 2 });
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
const nonce = (value: string) => Buffer.from(value.padEnd(16, '_')).toString('base64url');

function payload(overrides: Partial<OfflineInstructionV1> = {}): OfflineInstructionV1 {
  return {
    version: '1', envelopeId: 'env-1', authorizationId: 'grant-1', instructionId: 'instruction-1',
    deviceId: 'device-1', keyVersion: 'key-1', nonce: nonce('nonce-1'),
    issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 10_000,
    assetCode: 'USD', assetScale: 2, maxDebitMinor: '60', merchantScopeId: 'merchant-1',
    ...overrides,
  };
}

function signed(body = payload()): SignedOfflineInstructionV1 {
  return { payload: body, signature: sign(null, offlineInstructionSigningBytes(body), keys.privateKey).toString('base64url') };
}

function context(): OfflinePolicyContext {
  const grant: GrantAuthorization = {
    authorizationId: 'grant-1', userId: 7, status: 'ACTIVE', authorityRef: 'opaque-ref', kind: 'OUTGOING_PAYMENT',
    perPaymentMaxDebit: USD('100'), cumulativeCap: USD('300'), cumulativeSpent: USD('20'),
    validFromEpochMs: NOW - 5000, validUntilEpochMs: NOW + 30_000,
    payerAssetCode: 'USD', payerAssetScale: 2, merchantScopeId: 'merchant-1', revocationVersion: 4,
    receiverBindingId: 'merchant-wallet',
  };
  return {
    nowEpochMs: NOW,
    envelope: {
      version: '1', envelopeId: 'env-1', authorizationId: 'grant-1', ownerUserId: 7, payerWalletId: 'payer-wallet',
      deviceId: 'device-1', deviceKeyVersion: 'key-1', deviceRevocationVersion: 3, grantRevocationVersion: 4,
      perPaymentMaxDebit: USD('100'), cumulativeCap: USD('300'), validFromEpochMs: NOW - 5000,
      validUntilEpochMs: NOW + 30_000, revoked: false, merchantScopeId: 'merchant-1',
    },
    grant,
    authority: { ownerUserId: 7, authorizationId: 'grant-1', payerWalletId: 'payer-wallet', usable: true, restrictionsVerified: true, snapshotId: 'authority-1', observedAtEpochMs: NOW - 1000, validUntilEpochMs: NOW + 5000, cumulativeCap: USD('300'), spentDebit: USD('20') },
    device: { ownerUserId: 7, deviceId: 'device-1', keyVersion: 'key-1', revocationVersion: 3, active: true, publicKey },
    wallet: { ownerUserId: 7, walletId: 'payer-wallet', verified: true },
    merchant: { scopeId: 'merchant-1', walletId: 'merchant-wallet', verified: true },
    quote: { quoteId: 'quote-1', merchantScopeId: 'merchant-1', payerWalletId: 'payer-wallet', receiverWalletId: 'merchant-wallet', payerDebit: USD('50'), merchantReceive: EUR('1000'), expiresAtEpochMs: NOW + 2000 },
    expectedMerchantReceive: EUR('1000'), outstandingReservations: USD('30'),
  };
}

class AtomicFake {
  readonly calls: OfflineAtomicReservationRequest[] = [];
  readonly claimed = new Map<string, string>();
  reserved = 0n;
  constructor(readonly remaining: bigint = 250n) {}
  async claimAndReserve(request: OfflineAtomicReservationRequest): Promise<ClaimResult> {
    this.calls.push(request);
    const previous = this.claimed.get(request.nonce);
    if (previous) return { kind: 'ALREADY_CLAIMED', priorInstructionId: previous };
    if (this.reserved + BigInt(request.maxPotentialDebit.value) > this.remaining) return { kind: 'INSUFFICIENT_BUDGET', code: 'CLAIM_INSUFFICIENT_BUDGET' };
    this.claimed.set(request.nonce, request.instructionId);
    this.reserved += BigInt(request.maxPotentialDebit.value);
    return { kind: 'CLAIMED', paymentId: `payment-${this.calls.length}` };
  }
}

function ports(ctx = context(), atomic = new AtomicFake()): OfflineRedemptionPorts {
  return { loadDeviceEnrollment: async () => ctx.device, loadContext: async () => ctx, nowEpochMs: () => NOW, claimAndReserve: (request) => atomic.claimAndReserve(request) };
}

test('signed instruction verifies with the enrolled key; altered amounts, keys and signatures fail', () => {
  const instruction = signed();
  assert.deepEqual(parseSignedOfflineInstruction(instruction), instruction);
  assert.equal(verifyOfflineInstructionSignature(instruction, publicKey), true);
  assert.equal(verifyOfflineInstructionSignature({ ...instruction, payload: { ...instruction.payload, maxDebitMinor: '61' } }, publicKey), false);
  assert.equal(verifyOfflineInstructionSignature(instruction, otherKeys.publicKey.export({ format: 'jwk' }).x!), false);
  assert.equal(verifyOfflineInstructionSignature({ ...instruction, signature: 'A'.repeat(86) }, publicKey), false);
});

test('signature covers every binding, expiry and payer-asset field', () => {
  const original = signed();
  const changes: Partial<OfflineInstructionV1>[] = [
    { envelopeId: 'env-2' }, { authorizationId: 'grant-2' }, { instructionId: 'instruction-2' },
    { deviceId: 'device-2' }, { keyVersion: 'key-2' }, { nonce: nonce('different') },
    { issuedAtEpochMs: NOW - 2000 }, { expiresAtEpochMs: NOW + 20_000 },
    { assetCode: 'EUR' }, { assetScale: 3 }, { maxDebitMinor: '59' }, { merchantScopeId: 'merchant-2' },
  ];
  for (const change of changes) {
    assert.equal(verifyOfflineInstructionSignature({ ...original, payload: { ...original.payload, ...change } }, publicKey), false);
  }
});

test('documented public interoperability vector verifies the exact canonical bytes', () => {
  const body = payload({ nonce: 'MDEyMzQ1Njc4OWFiY2RlZg', issuedAtEpochMs: 1700000000000, expiresAtEpochMs: 1700000060000 });
  const expected = '{"body":{"assetCode":"USD","assetScale":2,"authorizationId":"grant-1","deviceId":"device-1","envelopeId":"env-1","expiresAtEpochMs":1700000060000,"instructionId":"instruction-1","issuedAtEpochMs":1700000000000,"keyVersion":"key-1","maxDebitMinor":"60","merchantScopeId":"merchant-1","nonce":"MDEyMzQ1Njc4OWFiY2RlZg","purpose":"atomic-commits/offline-payment","version":"1"},"version":"1"}';
  assert.equal(Buffer.from(offlineInstructionSigningBytes(body)).toString('utf8'), expected);
  assert.equal(verifyOfflineInstructionSignature({ payload: body, signature: 'qjetMd3QjV6TXJTo-G4Yesg1yX27xaqoH8NC01mCeWvDQBl1DxhpdTBfnME5KdHSeatVDuXPLeEVPKzVjPBZAw' }, 'dZ3FNPiVCIIz92ye9xThyC7aHFheRaXpBVp3bmK-gFY'), true);
});

test('strict QR parser rejects credentials, extra fields, malformed nonce, version and amounts', () => {
  const good = signed();
  assert.equal(parseSignedOfflineInstruction({ ...good, providerToken: 'secret' }), undefined);
  assert.equal(parseSignedOfflineInstruction({ ...good, payload: { ...good.payload, privateKey: 'secret' } }), undefined);
  assert.equal(parseSignedOfflineInstruction({ ...good, payload: { ...good.payload, nonce: 'short' } }), undefined);
  assert.equal(parseSignedOfflineInstruction({ ...good, payload: { ...good.payload, version: '2' } }), undefined);
  assert.equal(parseSignedOfflineInstruction({ ...good, payload: { ...good.payload, maxDebitMinor: '01' } }), undefined);
  assert.equal(parseSignedOfflineInstruction({ ...good, signature: `${good.signature}=` }), undefined);
});

test('policy separates payer debit from merchant receive and reserves the signed ceiling', () => {
  const decision = evaluateOfflineSpendingPolicy(payload(), context());
  assert.deepEqual(decision, { allowed: true, maxPotentialDebit: USD('60') });
  const tooExpensive = context();
  const result = evaluateOfflineSpendingPolicy(payload(), { ...tooExpensive, quote: { ...tooExpensive.quote, payerDebit: USD('61'), merchantReceive: EUR('1') }, expectedMerchantReceive: EUR('1') });
  assert.deepEqual(result, { allowed: false, code: 'OVER_TRANSACTION_CEILING' });
});

test('policy rejects unavailable authority, revoked device, foreign wallet and unverified merchant', () => {
  const ctx = context();
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...ctx, authority: { ...ctx.authority, usable: false } }).allowed, false);
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...ctx, authority: { ...ctx.authority, validUntilEpochMs: NOW } }).allowed, false);
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), { ...ctx, device: { ...ctx.device, active: false } }), { allowed: false, code: 'DEVICE_NOT_VERIFIED' });
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...ctx, wallet: { ...ctx.wallet, ownerUserId: 8 } }).allowed, false);
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), { ...ctx, merchant: { ...ctx.merchant, verified: false } }), { allowed: false, code: 'MERCHANT_NOT_VERIFIED' });
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), { ...ctx, grant: { ...ctx.grant, revocationVersion: 5 } }), { allowed: false, code: 'GRANT_REAUTHORIZATION_REQUIRED' });
});

test('policy fails closed for expiry, mismatched assets, stale quote and cumulative reservations', () => {
  const ctx = context();
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload({ expiresAtEpochMs: NOW }), ctx), { allowed: false, code: 'OFFLINE_CREDENTIAL_EXPIRED' });
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload({ issuedAtEpochMs: NOW + 1 }), ctx), { allowed: false, code: 'OFFLINE_CREDENTIAL_EXPIRED' });
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...ctx, quote: { ...ctx.quote, payerDebit: EUR('50') } }).allowed, false);
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...ctx, quote: { ...ctx.quote, expiresAtEpochMs: NOW } }).allowed, false);
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), { ...ctx, outstandingReservations: USD('280') }), { allowed: false, code: 'CUMULATIVE_BUDGET_EXCEEDED' });
});

test('a trip-level ceiling is automatically narrowed to remaining allowance', async () => {
  const ctx = { ...context(), outstandingReservations: USD('230') }; // 300 - (20 spent + 230 pending) = 50
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), ctx), { allowed: true, maxPotentialDebit: USD('50') });
  const atomic = new AtomicFake();
  const result = await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports(ctx, atomic));
  assert.equal(result.status, 'RESERVED');
  if (result.status !== 'RESERVED') throw new Error('expected reservation');
  assert.deepEqual(result.reservedMaximum, USD('50'));
  const over = { ...ctx, quote: { ...ctx.quote, payerDebit: USD('51') } };
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports(over)),
    { status: 'REJECTED', code: 'OVER_TRANSACTION_CEILING' });
});

test('fresh null counters require an isolated first use and explicit post-debit reconciliation', () => {
  const ctx = context();
  const fresh: OfflinePolicyContext = {
    ...ctx,
    grant: { ...ctx.grant, cumulativeSpent: USD('0') },
    authority: { ...ctx.authority, spentDebit: null, freshGrantEmpty: true },
    outstandingReservations: USD('0'),
  };
  assert.deepEqual(evaluateOfflineSpendingPolicy(payload(), fresh), {
    allowed: true, maxPotentialDebit: USD('60'), requiresInitialCounterReconciliation: true,
  });
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...fresh, authority: { ...fresh.authority, freshGrantEmpty: false } }).allowed, false);
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...fresh, outstandingReservations: USD('1') }).allowed, false);
  assert.equal(evaluateOfflineSpendingPolicy(payload(), { ...fresh, grant: { ...fresh.grant, cumulativeSpent: USD('1') } }).allowed, false);
});

test('generic reservation refuses fresh-null bootstrap without a durable reconciliation adapter', async () => {
  const ctx = context();
  const fresh: OfflinePolicyContext = {
    ...ctx, grant: { ...ctx.grant, cumulativeSpent: USD('0') },
    authority: { ...ctx.authority, spentDebit: null, freshGrantEmpty: true }, outstandingReservations: USD('0'),
  };
  const atomic = new AtomicFake();
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports(fresh, atomic)), {
    status: 'REJECTED', code: 'GRANT_REAUTHORIZATION_REQUIRED',
  });
  assert.equal(atomic.calls.length, 0);
});

test('signature and owner/merchant checks run before any atomic claim', async () => {
  const atomic = new AtomicFake();
  const instruction = signed();
  const altered = { ...instruction, payload: { ...instruction.payload, maxDebitMinor: '80' } };
  assert.deepEqual(await reserveSignedOfflineInstruction(altered, 'merchant-1', EUR('1000'), ports(context(), atomic)), { status: 'REJECTED', code: 'DEVICE_NOT_VERIFIED' });
  assert.deepEqual(await reserveSignedOfflineInstruction(instruction, 'foreign-merchant', EUR('1000'), ports(context(), atomic)), { status: 'REJECTED', code: 'MERCHANT_NOT_VERIFIED' });
  assert.equal(atomic.calls.length, 0);
});

test('invalid signatures cannot trigger a provider quote or an atomic claim', async () => {
  let contextLookups = 0;
  let claims = 0;
  const original = signed();
  const altered = { ...original, payload: { ...original.payload, maxDebitMinor: '80' } };
  const result = await reserveSignedOfflineInstruction(altered, 'merchant-1', EUR('1000'), {
    ...ports(),
    loadContext: async () => { contextLookups++; return context(); },
    claimAndReserve: async () => { claims++; return { kind: 'CLAIMED', paymentId: 'never' }; },
  });
  assert.deepEqual(result, { status: 'REJECTED', code: 'DEVICE_NOT_VERIFIED' });
  assert.equal(contextLookups, 0);
  assert.equal(claims, 0);
});

test('a device-key change during context loading invalidates the verified snapshot', async () => {
  const ctx = context();
  const mutableDevice = { ...ctx.device };
  let claims = 0;
  const result = await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), {
    ...ports(ctx),
    loadDeviceEnrollment: async () => mutableDevice,
    loadContext: async () => {
      mutableDevice.publicKey = otherKeys.publicKey.export({ format: 'jwk' }).x!;
      return { ...ctx, device: mutableDevice };
    },
    claimAndReserve: async () => { claims++; return { kind: 'CLAIMED', paymentId: 'never' }; },
  });
  assert.deepEqual(result, { status: 'REJECTED', code: 'DEVICE_NOT_VERIFIED' });
  assert.equal(claims, 0);
});

test('quote must match the merchant-requested receive amount and both trusted wallets', async () => {
  const atomic = new AtomicFake();
  const ctx = context();
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('999'), ports(ctx, atomic)), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports({ ...ctx, quote: { ...ctx.quote, receiverWalletId: 'wrong-wallet' } }, atomic)), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports({ ...ctx, quote: { ...ctx.quote, payerWalletId: 'wrong-wallet' } }, atomic)), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  assert.equal(atomic.calls.length, 0);
});

test('successful reservation carries the exact nonce, revisions, quote and signed maximum', async () => {
  const atomic = new AtomicFake();
  const instruction = signed();
  const result = await reserveSignedOfflineInstruction(instruction, 'merchant-1', EUR('1000'), ports(context(), atomic));
  assert.equal(result.status, 'RESERVED');
  assert.equal(atomic.calls.length, 1);
  assert.equal(atomic.calls[0].nonce, instruction.payload.nonce);
  assert.equal(atomic.calls[0].expectedDeviceRevocationVersion, 3);
  assert.equal(atomic.calls[0].expectedGrantRevocationVersion, 4);
  assert.equal(atomic.calls[0].authoritySnapshotId, 'authority-1');
  assert.equal(atomic.calls[0].authorityValidUntilEpochMs, NOW + 5000);
  assert.equal(atomic.calls[0].quoteId, 'quote-1');
  assert.deepEqual(atomic.calls[0].merchantReceive, EUR('1000'));
  assert.deepEqual(atomic.calls[0].maxPotentialDebit, USD('60'));
  assert.match(atomic.calls[0].requestFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(result).includes(instruction.signature));
});

test('fingerprint binds the merchant receive amount without depending on the provider quote ID', async () => {
  const instruction = signed();
  const ctx = context();
  const first = await reserveSignedOfflineInstruction(instruction, 'merchant-1', EUR('1000'), ports(ctx));
  const requote = await reserveSignedOfflineInstruction(instruction, 'merchant-1', EUR('1000'), ports({ ...ctx, quote: { ...ctx.quote, quoteId: 'quote-2' } }));
  const changedAmount = await reserveSignedOfflineInstruction(instruction, 'merchant-1', EUR('999'), ports({ ...ctx, quote: { ...ctx.quote, merchantReceive: EUR('999') } }));
  assert.equal(first.status, 'RESERVED');
  assert.equal(requote.status, 'RESERVED');
  assert.equal(changedAmount.status, 'RESERVED');
  if (first.status !== 'RESERVED' || requote.status !== 'RESERVED' || changedAmount.status !== 'RESERVED') throw new Error('expected mock reservations');
  assert.equal(first.requestFingerprint, requote.requestFingerprint);
  assert.notEqual(first.requestFingerprint, changedAmount.requestFingerprint);
});

test('concurrent replay of one nonce admits one claim, even under different instruction IDs', async () => {
  const atomic = new AtomicFake();
  const first = signed();
  const second = signed(payload({ instructionId: 'instruction-2' }));
  const results = await Promise.all([
    reserveSignedOfflineInstruction(first, 'merchant-1', EUR('1000'), ports(context(), atomic)),
    reserveSignedOfflineInstruction(second, 'merchant-1', EUR('1000'), ports(context(), atomic)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['REJECTED', 'RESERVED']);
  assert.equal(atomic.reserved, 60n);
});

test('atomic adapter resolves concurrent budget contention rather than trusting stale snapshots', async () => {
  const atomic = new AtomicFake(100n);
  const results = await Promise.all([
    reserveSignedOfflineInstruction(signed(payload({ instructionId: 'instruction-1', nonce: nonce('first') })), 'merchant-1', EUR('1000'), ports(context(), atomic)),
    reserveSignedOfflineInstruction(signed(payload({ instructionId: 'instruction-2', nonce: nonce('second') })), 'merchant-1', EUR('1000'), ports(context(), atomic)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['REJECTED', 'RESERVED']);
  assert.equal(atomic.reserved, 60n);
});

test('separate enrolled devices contend for the same cumulative budget', async () => {
  const ctx = context();
  const otherPublic = otherKeys.publicKey.export({ format: 'jwk' }).x!;
  const secondContext: OfflinePolicyContext = {
    ...ctx,
    envelope: { ...ctx.envelope, envelopeId: 'env-2', deviceId: 'device-2', deviceKeyVersion: 'key-2' },
    device: { ...ctx.device, deviceId: 'device-2', keyVersion: 'key-2', publicKey: otherPublic },
  };
  const secondPayload = payload({ envelopeId: 'env-2', instructionId: 'instruction-2', deviceId: 'device-2', keyVersion: 'key-2', nonce: nonce('second-device') });
  const secondInstruction = { payload: secondPayload, signature: sign(null, offlineInstructionSigningBytes(secondPayload), otherKeys.privateKey).toString('base64url') };
  const atomic = new AtomicFake(100n);
  const results = await Promise.all([
    reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), ports(ctx, atomic)),
    reserveSignedOfflineInstruction(secondInstruction, 'merchant-1', EUR('1000'), ports(secondContext, atomic)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['REJECTED', 'RESERVED']);
  assert.equal(atomic.reserved, 60n);
});

test('releasing a fake reservation does not make a previously claimed nonce reusable', async () => {
  const atomic = new AtomicFake();
  const original = signed();
  assert.equal((await reserveSignedOfflineInstruction(original, 'merchant-1', EUR('1000'), ports(context(), atomic))).status, 'RESERVED');
  atomic.reserved = 0n; // model a confirmed-failure budget release; retain the nonce record
  assert.deepEqual(await reserveSignedOfflineInstruction(original, 'merchant-1', EUR('1000'), ports(context(), atomic)), { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
});

test('ambiguous atomic claim is not retried or treated as a settled payment', async () => {
  let calls = 0;
  const result = await reserveSignedOfflineInstruction(signed(), 'merchant-1', EUR('1000'), {
    ...ports(), claimAndReserve: async () => { calls++; throw new Error('timeout after transaction'); },
  });
  assert.equal(result.status, 'RESERVATION_UNKNOWN');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('timeout'));
});
