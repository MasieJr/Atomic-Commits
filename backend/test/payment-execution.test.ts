import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createOfflineVoucherInstruction } from '../src/dev/offline-sender';
import { PaymentEngineError } from '../src/domain/payment-engine/errors';
import type { Money } from '../src/domain/payment-engine/money';
import type { OfflinePreQuoteContext } from '../src/domain/payment-engine/offline-spending-policy';
import type { PaymentResult } from '../src/domain/payment-engine/payments';
import {
  PaymentExecutionService,
  type ExecutionClaim,
  type ExecutionClaimOutcome,
  type ExecutionClaimRequest,
  type ExecutionQuote,
  type OnlineExecutionContext,
  type PaymentExecutionPorts,
  type PaymentExecutionStore,
  type ProviderExecutionObservation,
  type StoredExecution,
} from '../src/domain/payment-engine/payment-execution';

const START = 1_700_000_000_000;
const zar = (value: string): Money => ({ value, assetCode: 'ZAR', assetScale: 2 });
const eur = (value: string): Money => ({ value, assetCode: 'EUR', assetScale: 2 });

interface RecordEntry {
  request: ExecutionClaimRequest;
  claim: ExecutionClaim;
  result: PaymentResult;
  quote?: ExecutionQuote;
  minimumSpentBefore?: Money;
  aggregateCap?: Money;
  confirmedSpentCounter?: Money;
  noDebitConfirmed?: boolean;
  providerAttemptRef?: string;
  held: boolean;
  providerCalled: boolean;
  disputed?: boolean;
}

class MemoryStore implements PaymentExecutionStore {
  entries = new Map<string, RecordEntry>();
  keys = new Map<string, { fingerprint: string; attemptId: string }>();
  nonces = new Set<string>();
  beginResult: 'STARTED' | 'REFUSED' | 'UNKNOWN' = 'STARTED';
  recordFails = false;
  rejectFails = false;
  claimCount = 0;
  recordedCounters: Money[] = [];

  view(entry: RecordEntry): StoredExecution {
    return { claim: entry.claim, quote: entry.quote, result: entry.result, providerAttemptRef: entry.providerAttemptRef,
      minimumSpentBefore: entry.minimumSpentBefore, aggregateCap: entry.aggregateCap, confirmedSpentCounter: entry.confirmedSpentCounter,
      noDebitConfirmed: entry.noDebitConfirmed };
  }

  async findOnline(input: { userId: number; idempotencyKey: string; requestFingerprint: string }) {
    const found = this.keys.get(`${input.userId}:${input.idempotencyKey}`);
    if (!found) return { kind: 'NOT_FOUND' as const };
    if (found.fingerprint !== input.requestFingerprint) return { kind: 'CONFLICT' as const };
    return { kind: 'PREVIOUS' as const, ownerUserId: input.userId, requestFingerprint: found.fingerprint, stored: this.view(this.entries.get(found.attemptId)!) };
  }

  held(excludeAttemptId?: string): bigint {
    return [...this.entries.values()].filter((entry) => entry.held && entry.claim.attemptId !== excludeAttemptId)
      .reduce((sum, entry) => sum + BigInt(entry.claim.reservedMaximum.value), 0n);
  }

  async claim(request: ExecutionClaimRequest): Promise<ExecutionClaimOutcome> {
    if (request.kind === 'ONLINE') {
      const found = this.keys.get(`${request.ownerUserId}:${request.idempotencyKey}`);
      if (found && found.fingerprint === request.requestFingerprint) {
        return { kind: 'PREVIOUS', ownerUserId: request.ownerUserId, requestFingerprint: found.fingerprint, stored: this.view(this.entries.get(found.attemptId)!) };
      }
      if (found) return { kind: 'REJECTED', code: 'IDEMPOTENCY_CONFLICT' };
    }
    if (request.offline && this.nonces.has(request.offline.nonce)) return { kind: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' };
    if (request.freshGrantEmpty && this.held() > 0n) return { kind: 'REJECTED', code: 'GRANT_REAUTHORIZATION_REQUIRED' };
    const spent = this.recordedCounters.reduce((maximum, current) => BigInt(current.value) > maximum ? BigInt(current.value) : maximum, 0n);
    const remaining = 600n - this.held() - spent;
    if (remaining <= 0n) return { kind: 'REJECTED', code: 'CUMULATIVE_BUDGET_EXCEEDED' };
    const reserved = BigInt(request.maximumDebit.value) < remaining ? BigInt(request.maximumDebit.value) : remaining;
    const id = String(++this.claimCount);
    const claim: ExecutionClaim = {
      paymentId: `payment-${id}`, attemptId: `attempt-${id}`, ownerUserId: request.ownerUserId, authorizationId: request.authorizationId,
      payerWalletId: request.payerWalletId, merchantScopeId: request.merchantScopeId, merchantWalletId: request.merchantWalletId,
      snapshotId: request.snapshotId, requestFingerprint: request.requestFingerprint, merchantReceive: { ...request.merchantReceive },
      reservedMaximum: { ...request.maximumDebit, value: reserved.toString() }, freshGrantEmpty: request.freshGrantEmpty,
    };
    const result: PaymentResult = { paymentId: claim.paymentId, attemptId: claim.attemptId, status: 'AWAITING_AUTHORIZATION' };
    this.entries.set(claim.attemptId, { request, claim, result, held: true, providerCalled: false });
    if (request.idempotencyKey) this.keys.set(`${request.ownerUserId}:${request.idempotencyKey}`, { fingerprint: request.requestFingerprint, attemptId: claim.attemptId });
    if (request.offline) this.nonces.add(request.offline.nonce);
    return { kind: 'CLAIMED', claim };
  }

  async beginSubmission(input: { claim: ExecutionClaim; quote: ExecutionQuote; minimumSpentBefore: Money; aggregateCap: Money }) {
    if (this.beginResult !== 'STARTED') return this.beginResult;
    const entry = this.entries.get(input.claim.attemptId)!;
    assert.equal(entry.result.status, 'AWAITING_AUTHORIZATION');
    entry.quote = input.quote;
    entry.minimumSpentBefore = input.minimumSpentBefore;
    entry.aggregateCap = input.aggregateCap;
    entry.result = { paymentId: input.claim.paymentId, attemptId: input.claim.attemptId, status: 'SUBMITTING' };
    return 'STARTED' as const;
  }

  async rejectBeforeSubmission(input: { claim: ExecutionClaim; code: PaymentResult['failureCode'] }) {
    if (this.rejectFails) throw new Error('database unavailable');
    const entry = this.entries.get(input.claim.attemptId)!;
    assert.equal(entry.providerCalled, false, 'cannot release after the provider was called');
    entry.result = { paymentId: input.claim.paymentId, attemptId: input.claim.attemptId, status: 'REJECTED', failureCode: input.code };
    entry.noDebitConfirmed = true;
    entry.held = false;
    return 'REJECTED' as const;
  }

  async recordOutcome(input: { claim: ExecutionClaim; result: PaymentResult; providerAttemptRef?: string; confirmedSpentCounter?: Money; noDebitConfirmed?: true }) {
    if (this.recordFails) throw new Error('database unavailable');
    const entry = this.entries.get(input.claim.attemptId)!;
    if (['SUCCEEDED', 'FAILED', 'REJECTED'].includes(entry.result.status)) {
      if (['SUCCEEDED', 'FAILED', 'REJECTED'].includes(input.result.status) && input.result.status !== entry.result.status) {
        entry.disputed = true;
        entry.result = { paymentId: entry.claim.paymentId, attemptId: entry.claim.attemptId, status: 'UNKNOWN' };
        entry.held = true;
        return { kind: 'UNKNOWN' as const };
      }
      return { kind: 'PREVIOUS' as const, stored: this.view(entry) };
    }
    entry.result = input.result;
    if (input.providerAttemptRef) entry.providerAttemptRef = input.providerAttemptRef;
    if (input.confirmedSpentCounter) { this.recordedCounters.push(input.confirmedSpentCounter); entry.confirmedSpentCounter = input.confirmedSpentCounter; }
    if (input.noDebitConfirmed) entry.noDebitConfirmed = true;
    if (input.result.status === 'SUCCEEDED' || input.result.status === 'REJECTED') entry.held = false;
    return { kind: 'RECORDED' as const };
  }

  async loadExecution(userId: number, paymentId: string): Promise<StoredExecution | undefined> {
    const entry = [...this.entries.values()].find((candidate) => candidate.claim.paymentId === paymentId && candidate.claim.ownerUserId === userId);
    return entry && this.view(entry);
  }
}

function world(options: { fresh?: boolean } = {}) {
  const store = new MemoryStore();
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ format: 'jwk' }).x!;
  const calls: string[] = [];
  let clock = START;
  let counter: Money | null = options.fresh ? null : zar('0');
  let merchantOverride: string | undefined;
  let revokedAfterQuote = false;
  let quoteDebit = '186';
  let quoteExpires = START + 30000;
  let submit: (claim: ExecutionClaim, quote: ExecutionQuote) => Promise<ProviderExecutionObservation> = async (claim, quote) => {
    counter = zar((BigInt(counter?.value ?? '0') + BigInt(quote.payerDebit.value)).toString());
    return { kind: 'CONFIRMED', providerAttemptRef: `provider-${claim.attemptId}`, payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive };
  };
  let read: (claim: ExecutionClaim, quote: ExecutionQuote, ref: string) => Promise<ProviderExecutionObservation> = async (claim, quote, ref) =>
    ({ kind: 'CONFIRMED', providerAttemptRef: ref, payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive });
  const current = (merchantScopeId: string, excludeAttemptId?: string): OfflinePreQuoteContext => {
    const actualMerchant = merchantOverride ?? merchantScopeId;
    const spent = counter?.value ?? '0';
    return {
      nowEpochMs: clock,
      envelope: { version: '1', envelopeId: 'envelope', authorizationId: 'grant', ownerUserId: 7, payerWalletId: 'payer-wallet',
        deviceId: 'device', deviceKeyVersion: 'key', deviceRevocationVersion: 1, grantRevocationVersion: 1,
        perPaymentMaxDebit: zar('200'), cumulativeCap: zar('600'), validFromEpochMs: START - 5000, validUntilEpochMs: START + 60000, revoked: false },
      grant: { authorizationId: 'grant', userId: 7, status: revokedAfterQuote ? 'REVOKED' : 'ACTIVE', authorityRef: 'opaque-ref', kind: 'OUTGOING_PAYMENT',
        perPaymentMaxDebit: zar('200'), cumulativeCap: zar('600'), cumulativeSpent: zar(spent), validFromEpochMs: START - 5000,
        validUntilEpochMs: START + 90000, payerAssetCode: 'ZAR', payerAssetScale: 2, revocationVersion: 1 },
      authority: { ownerUserId: 7, authorizationId: 'grant', payerWalletId: 'payer-wallet', usable: true, restrictionsVerified: true,
        snapshotId: 'snapshot', observedAtEpochMs: START - 100, validUntilEpochMs: START + 80000, cumulativeCap: zar('600'),
        spentDebit: counter, ...(counter === null ? { freshGrantEmpty: true } : {}) },
      device: { ownerUserId: 7, deviceId: 'device', keyVersion: 'key', revocationVersion: 1, active: true, publicKey },
      wallet: { ownerUserId: 7, walletId: 'payer-wallet', verified: true },
      merchant: { scopeId: actualMerchant, walletId: 'merchant-wallet', verified: true },
      outstandingReservations: zar(store.held(excludeAttemptId).toString()),
    };
  };
  const ports: PaymentExecutionPorts = {
    nowEpochMs: () => clock,
    store,
    snapshots: {
      loadDeviceEnrollment: async () => { calls.push('device'); return current('merchant').device; },
      loadOfflineContext: async (_envelope, merchant, exclude) => { calls.push('offline-context'); return current(merchant, exclude); },
      loadOnlineContext: async (_user, _authorization, merchant, exclude): Promise<OnlineExecutionContext> => {
        calls.push('online-context');
        const { grant, authority, wallet, merchant: found, outstandingReservations } = current(merchant, exclude);
        return { grant, authority, wallet, merchant: found, outstandingReservations };
      },
    },
    provider: {
      createQuote: async ({ claim, merchantReceive }) => {
        calls.push('quote');
        return { quoteId: `quote-${claim.attemptId}`, incomingPaymentId: `incoming-${claim.attemptId}`, payerWalletId: claim.payerWalletId,
          merchantScopeId: claim.merchantScopeId, merchantWalletId: claim.merchantWalletId, payerDebit: zar(quoteDebit), merchantReceive,
          expiresAtEpochMs: quoteExpires };
      },
      submitOnce: async ({ claim, quote }) => {
        calls.push('submit');
        store.entries.get(claim.attemptId)!.providerCalled = true;
        return submit(claim, quote);
      },
      readPayment: async ({ claim, quote, providerAttemptRef }) => { calls.push('read-payment'); return read(claim, quote, providerAttemptRef); },
      readSpentCounter: async () => { calls.push('counter'); return counter; },
    },
  };
  const service = new PaymentExecutionService(ports);
  const online = { userId: 7, idempotencyKey: 'request-1', authorizationId: 'grant', merchantScopeId: 'merchant', merchantReceive: eur('10') };
  const voucher = () => createOfflineVoucherInstruction({ envelopeId: 'envelope', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('200'), issuedAtEpochMs: START - 1000, expiresAtEpochMs: START + 30000 }, key.privateKey);
  return { service, store, ports, calls, online, voucher, setClock: (v: number) => { clock = v; }, setCounter: (v: Money | null) => { counter = v; },
    setMerchant: (v: string) => { merchantOverride = v; }, revoke: () => { revokedAfterQuote = true; },
    setQuoteDebit: (v: string) => { quoteDebit = v; }, setQuoteExpiry: (v: number) => { quoteExpires = v; },
    setSubmit: (v: typeof submit) => { submit = v; }, setRead: (v: typeof read) => { read = v; } };
}

function code(expected: string) {
  return (error: unknown) => error instanceof PaymentEngineError && error.code === expected;
}

test('online purchase uses one claim and reconciles the provider before returning success', async () => {
  const w = world({ fresh: true });
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.payerDebitPaid, zar('186'));
  assert.deepEqual(result.merchantReceivePaid, eur('10'));
  assert.deepEqual(w.store.recordedCounters, [zar('186')]);
  assert.deepEqual(await w.service.online(w.online), result);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
  assert.equal(w.store.held(), 0n);
});

test('concurrent idempotent online requests cannot start two debits', async () => {
  const w = world();
  const results = await Promise.all([w.service.online(w.online), w.service.online(w.online)]);
  assert.ok(results.some((result) => result.status === 'SUCCEEDED'));
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
  assert.equal(w.store.claimCount, 1);
  await assert.rejects(w.service.online({ ...w.online, merchantReceive: eur('11') }), code('IDEMPOTENCY_CONFLICT'));
});

test('concurrent distinct requests cannot reserve above the grant cap', async () => {
  const w = world();
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    w.service.online({ ...w.online, idempotencyKey: `request-${index}` })));
  assert.ok(outcomes.some((outcome) => outcome.status === 'rejected' && code('CUMULATIVE_BUDGET_EXCEEDED')(outcome.reason)));
  assert.ok(w.calls.filter((call) => call === 'submit').length <= 3);
  assert.ok([...w.store.entries.values()].reduce((sum, entry) => sum + BigInt(entry.claim.reservedMaximum.value), 0n) <= 600n);
});

test('offline voucher uses the authenticated merchant, consumes its nonce and rejects replay', async () => {
  const w = world();
  const instruction = w.voucher();
  const result = await w.service.redeemSigned({ instruction, merchantScopeId: 'merchant', merchantReceive: eur('10') });
  assert.equal(result.status, 'SUCCEEDED');
  await assert.rejects(w.service.redeemSigned({ instruction, merchantScopeId: 'merchant', merchantReceive: eur('10') }), code('OFFLINE_CREDENTIAL_ALREADY_CLAIMED'));
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('a fresh null/null grant permits one bounded offline claim only after numeric reconciliation', async () => {
  const w = world({ fresh: true });
  const result = await w.service.redeemSigned({ instruction: w.voucher(), merchantScopeId: 'merchant', merchantReceive: eur('10') });
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(w.store.recordedCounters, [zar('186')]);
  assert.equal(w.store.entries.get(result.attemptId)!.claim.freshGrantEmpty, true);
});

test('untrusted merchant context and changed signatures are rejected before any claim', async () => {
  const wrongMerchant = world();
  wrongMerchant.setMerchant('another-merchant');
  await assert.rejects(wrongMerchant.service.redeemSigned({ instruction: wrongMerchant.voucher(), merchantScopeId: 'merchant', merchantReceive: eur('10') }), code('MERCHANT_NOT_VERIFIED'));
  assert.equal(wrongMerchant.store.claimCount, 0);
  const tampered = world();
  const voucher = tampered.voucher();
  await assert.rejects(tampered.service.redeemSigned({ instruction: { ...voucher, payload: { ...voucher.payload, maxDebitMinor: '201' } },
    merchantScopeId: 'merchant', merchantReceive: eur('10') }), code('DEVICE_NOT_VERIFIED'));
  assert.equal(tampered.store.claimCount, 0);
  assert.ok(!tampered.calls.includes('quote'));
});

test('expired or over-ceiling quotes do not submit and consume the offline nonce', async () => {
  for (const mode of ['expired', 'over-ceiling'] as const) {
    const w = world();
    const instruction = w.voucher();
    if (mode === 'expired') w.setQuoteExpiry(START);
    else w.setQuoteDebit('201');
    const result = await w.service.redeemSigned({ instruction, merchantScopeId: 'merchant', merchantReceive: eur('10') });
    assert.equal(result.status, 'REJECTED');
    assert.equal(w.store.held(), 0n);
    assert.ok(!w.calls.includes('submit'));
    await assert.rejects(w.service.redeemSigned({ instruction, merchantScopeId: 'merchant', merchantReceive: eur('10') }), code('OFFLINE_CREDENTIAL_ALREADY_CLAIMED'));
  }
});

test('revocation after quote stops before any outgoing submission', async () => {
  const w = world();
  const original = w.ports.provider.createQuote;
  w.ports.provider.createQuote = async (input) => { const quote = await original(input); w.revoke(); return quote; };
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.failureCode, 'GRANT_REAUTHORIZATION_REQUIRED');
  assert.equal(w.store.held(), 0n);
  assert.ok(!w.calls.includes('submit'));
});

test('a quote that expires during the durable submission claim is never submitted', async () => {
  const w = world();
  const original = w.store.beginSubmission.bind(w.store);
  w.store.beginSubmission = async (input) => { const state = await original(input); w.setClock(START + 30000); return state; };
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'REJECTED');
  assert.equal(w.store.held(), 0n);
  assert.ok(!w.calls.includes('submit'));
});

test('an ambiguous submission stays reserved and a retry cannot issue a second debit', async () => {
  const w = world();
  w.setSubmit(async () => { throw new Error('connection dropped after POST'); });
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(w.store.held(), 200n);
  assert.equal((await w.service.online(w.online)).status, 'UNKNOWN');
  assert.equal((await w.service.reconcile(7, result.paymentId)).status, 'UNKNOWN');
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
  assert.ok(!w.calls.includes('read-payment'));
});

test('an unknown submission with a provider reference is reconciled by reads only', async () => {
  const w = world();
  w.setSubmit(async (claim) => ({ kind: 'UNKNOWN', providerAttemptRef: `provider-${claim.attemptId}` }));
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'UNKNOWN');
  w.setCounter(zar('186'));
  w.setClock(START + 70000); // quote expiry does not erase a submitted payment
  const reconciled = await w.service.reconcile(7, result.paymentId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
  assert.equal(w.calls.filter((call) => call === 'read-payment').length, 1);
  assert.equal(w.store.held(), 0n);
});

test('a lagging fresh counter stays unknown until a later numeric read reconciles', async () => {
  const w = world({ fresh: true });
  w.setSubmit(async (claim, quote) => ({ kind: 'CONFIRMED', providerAttemptRef: `provider-${claim.attemptId}`,
    payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive }));
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(w.store.held(), 200n);
  w.setCounter(zar('186'));
  assert.equal((await w.service.reconcile(7, result.paymentId)).status, 'SUCCEEDED');
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('missing, excessive or wrong-asset counters keep a confirmed provider debit unresolved', async () => {
  for (const counter of [null, zar('187'), { value: '186', assetCode: 'EUR', assetScale: 2 }]) {
    const w = world({ fresh: true });
    w.setSubmit(async (claim, quote) => { w.setCounter(counter); return { kind: 'CONFIRMED', providerAttemptRef: `provider-${claim.attemptId}`,
      payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive }; });
    const result = await w.service.online(w.online);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(w.store.held(), 200n);
  }
});

test('definitive no-debit rejection releases budget, whereas uncertain submission acquisition does not', async () => {
  const declined = world();
  declined.setSubmit(async () => ({ kind: 'NO_DEBIT' }));
  const rejected = await declined.service.online(declined.online);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.failureCode, 'PROVIDER_PAYMENT_REJECTED');
  assert.equal(declined.store.held(), 0n);
  const uncertain = world();
  uncertain.store.beginResult = 'UNKNOWN';
  const unknown = await uncertain.service.online(uncertain.online);
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(uncertain.store.held(), 200n);
  assert.ok(!uncertain.calls.includes('submit'));
});

test('a failed outcome write never turns a confirmed debit into a retry', async () => {
  const w = world();
  w.store.recordFails = true;
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal((await w.service.online(w.online)).status, 'SUBMITTING');
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
  assert.equal(w.store.held(), 200n);
});

test('provider data is snapshotted before asynchronous counter reconciliation', async () => {
  const w = world();
  const debit = { ...zar('186') };
  const receive = { ...eur('10') };
  w.setSubmit(async (claim) => ({ kind: 'CONFIRMED', providerAttemptRef: `provider-${claim.attemptId}`, payerDebit: debit, merchantReceive: receive }));
  w.ports.provider.readSpentCounter = async () => { debit.value = '500'; receive.value = '99'; return zar('186'); };
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.payerDebitPaid, zar('186'));
  assert.deepEqual(result.merchantReceivePaid, eur('10'));
});

test('a mismatched previous idempotency fingerprint is never returned as the caller’s result', async () => {
  const w = world();
  await w.service.online(w.online);
  const original = w.store.findOnline.bind(w.store);
  w.store.findOnline = async (input) => {
    const found = await original(input);
    return found.kind === 'PREVIOUS' ? { ...found, requestFingerprint: '0'.repeat(64) } : found;
  };
  await assert.rejects(w.service.online(w.online), code('PAYMENT_OUTCOME_UNKNOWN'));
  assert.equal(w.calls.filter((call) => call === 'quote').length, 1);
});

test('status lookup hides another owner and reconciliation rejects a changed provider reference', async () => {
  const w = world();
  w.setSubmit(async (claim) => ({ kind: 'UNKNOWN', providerAttemptRef: `provider-${claim.attemptId}` }));
  const result = await w.service.online(w.online);
  await assert.rejects(w.service.statusOf(8, result.paymentId), code('PAYMENT_NOT_FOUND'));
  w.setRead(async (_claim, quote) => ({ kind: 'CONFIRMED', providerAttemptRef: 'other-provider-payment', payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive }));
  assert.equal((await w.service.reconcile(7, result.paymentId)).status, 'UNKNOWN');
  assert.equal(w.store.held(), 200n);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('a cross-owner record returned by a broken adapter still appears not found', async () => {
  const w = world();
  const result = await w.service.online(w.online);
  const stored = w.store.view(w.store.entries.get(result.attemptId)!);
  w.store.loadExecution = async () => stored;
  await assert.rejects(w.service.statusOf(8, result.paymentId), code('PAYMENT_NOT_FOUND'));
  await assert.rejects(w.service.reconcile(8, result.paymentId), code('PAYMENT_NOT_FOUND'));
});

test('stored terminal outcomes require their original counter or no-debit evidence', async () => {
  const succeeded = world();
  const result = await succeeded.service.online(succeeded.online);
  const entry = succeeded.store.entries.get(result.attemptId)!;
  entry.confirmedSpentCounter = undefined;
  await assert.rejects(succeeded.service.statusOf(7, result.paymentId), code('PAYMENT_OUTCOME_UNKNOWN'));
  await assert.rejects(succeeded.service.online(succeeded.online), code('PAYMENT_OUTCOME_UNKNOWN'));

  const declined = world();
  declined.setSubmit(async () => ({ kind: 'NO_DEBIT' }));
  const rejected = await declined.service.online(declined.online);
  declined.store.entries.get(rejected.attemptId)!.noDebitConfirmed = false;
  await assert.rejects(declined.service.statusOf(7, rejected.paymentId), code('PAYMENT_OUTCOME_UNKNOWN'));
});

test('a conflicting stored terminal outcome is never presented as a verified success', async () => {
  const w = world();
  w.setSubmit(async (claim, quote) => {
    const entry = w.store.entries.get(claim.attemptId)!;
    entry.result = { paymentId: claim.paymentId, attemptId: claim.attemptId, status: 'REJECTED', failureCode: 'PROVIDER_PAYMENT_REJECTED' };
    entry.noDebitConfirmed = true;
    w.setCounter(zar('186'));
    return { kind: 'CONFIRMED', providerAttemptRef: `provider-${claim.attemptId}`, payerDebit: quote.payerDebit, merchantReceive: quote.merchantReceive };
  });
  const result = await w.service.online(w.online);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal((await w.service.statusOf(7, result.paymentId)).status, 'UNKNOWN');
  assert.equal(w.store.entries.get(result.attemptId)!.disputed, true);
  assert.equal(w.store.held(), 200n);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});
