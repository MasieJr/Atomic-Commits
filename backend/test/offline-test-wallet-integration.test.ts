import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { OpenPaymentsClientError, type AuthenticatedClient, type GrantWithAccessToken, type WalletAddress } from '@interledger/open-payments';
import type { OfflinePreQuoteContext } from '../src/domain/payment-engine/offline-spending-policy';
import { createOfflineTestWalletPorts } from '../src/dev/offline-test-wallet';
import { DevelopmentMerchantAuthenticator, DevelopmentReservationStore, executeDevelopmentOfflinePurchase, executeDevelopmentOfflineVoucher } from '../src/dev/offline-merchant-simulator';
import { runOfflineSender, runOfflineVoucherSender } from '../src/dev/offline-sender-process';
import { OutgoingGrantLifecycle } from '../src/services/grant-lifecycle';
import { PaymentProofs } from '../src/services/payment-proof';
import { ProofStepError, type PaymentEvidence, type ProofConfig, type ProofRun } from '../src/services/payment-proof-run';

const AUTH = 'https://auth.interledger-test.dev';
const RS = 'https://rs.interledger-test.dev';
const PAYER = 'https://wallet.interledger-test.dev/payer';
const RECEIVER = 'https://wallet.interledger-test.dev/receiver';
const INCOMING = `${RS}/incoming-1`;
const QUOTE = `${RS}/quote-1`;
const OUTGOING = `${RS}/outgoing-1`;
const zar = (value: string) => ({ value, assetCode: 'ZAR', assetScale: 2 });
const eur = (value: string) => ({ value, assetCode: 'EUR', assetScale: 2 });

async function world(mode: 'success' | 'timeout' | 'wrong-counter' | 'refreshed-over-limit' | 'four-payments' | 'resource-failure' | 'counter-failure' = 'success') {
  const now = Date.now();
  const keys = generateKeyPairSync('ed25519');
  const trip = mode === 'four-payments';
  const budget = trip ? '50000' : '600';
  const ceiling = trip ? '5000' : '200';
  let spent = 0n;
  let incomingSequence = 0;
  let currentIncoming = INCOMING;
  let currentQuote = QUOTE;
  let currentOutgoing = OUTGOING;
  const calls = { outgoing: 0, outgoingRead: 0, incomingRead: 0, quote: 0, counter: 0, resourceGrants: 0 };
  const runLike = {
    controller: new AbortController(),
    report: { version: 1, runId: 'development-run', mode: 'offline-exact', startedAt: new Date(now).toISOString(), status: 'RUNNING', currentStep: 'initialization', payments: [] as PaymentEvidence[], results: {} as Record<string, unknown> },
    rememberSecret: (_value: string) => {},
    save: async () => {},
    safeError: () => ({ message: 'redacted' }),
    step: async <T,>(_name: string, operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch (error) { throw new ProofStepError(_name, error); }
    },
  };
  const resourceGrant = (type: string) => ({
    access_token: { value: `${type}-token`, manage: `${AUTH}/manage-${type}`, expires_in: 600, access: [{ type }] },
    continue: { access_token: { value: `${type}-continue` }, uri: `${AUTH}/continue-${type}` },
  });
  const client = {
    grant: {
      request: async (_args: unknown, body: { access_token: { access: { type: string }[] } }) => {
        calls.resourceGrants++;
        if (mode === 'resource-failure') throw new OpenPaymentsClientError('private provider detail', { status: 429, code: 'too_fast', description: 'secret provider description' });
        return resourceGrant(body.access_token.access[0].type);
      },
      cancel: async () => {},
    },
    incomingPayment: {
      create: async () => { if (trip) currentIncoming = `${RS}/incoming-${++incomingSequence}`; return { id: currentIncoming, walletAddress: RECEIVER, receivedAmount: eur('0'), completed: false }; },
      get: async () => { calls.incomingRead++; return { id: currentIncoming, walletAddress: RECEIVER, receivedAmount: eur('10'), completed: true }; },
    },
    quote: {
      create: async () => {
        calls.quote++;
        const refreshed = mode === 'refreshed-over-limit' && calls.quote > 1;
        if (trip) currentQuote = `${RS}/quote-${calls.quote}`;
        return { id: currentQuote, walletAddress: PAYER, receiver: currentIncoming, method: 'ilp', debitAmount: zar(refreshed ? '201' : '186'),
          receiveAmount: eur('10'), expiresAt: new Date(now + (mode === 'refreshed-over-limit' && !refreshed ? 4000 : 90000)).toISOString() };
      },
    },
    outgoingPayment: {
      create: async () => {
        calls.outgoing++;
        if (mode === 'timeout') throw new Error('unknown provider response');
        spent = mode === 'wrong-counter' ? 200n : spent + 186n;
        if (trip) currentOutgoing = `${RS}/outgoing-${calls.outgoing}`;
        return { id: currentOutgoing };
      },
      get: async () => { calls.outgoingRead++; return { id: currentOutgoing, walletAddress: PAYER, receiver: currentIncoming, quoteId: currentQuote, debitAmount: zar('186'), sentAmount: zar('186'), failed: false }; },
      getGrantSpentAmounts: async () => {
        calls.counter++;
        if (mode === 'counter-failure' && calls.counter === 2) throw new OpenPaymentsClientError('private counter error', { status: 403, code: 'request_denied', description: 'secret detail' });
        return spent === 0n ? { spentDebitAmount: null, spentReceiveAmount: null } : { spentDebitAmount: zar(spent.toString()), spentReceiveAmount: eur(String(calls.outgoing * 10)) };
      },
    },
  } as unknown as AuthenticatedClient;
  const sender = { id: PAYER, assetCode: 'ZAR', assetScale: 2, authServer: AUTH, resourceServer: RS } as WalletAddress;
  const receiver = { id: RECEIVER, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: RS } as WalletAddress;
  const config: ProofConfig = { receiveMinor: '10', budgetMinor: budget, callbackPort: 3999, consentTimeoutMs: 60000, settlementTimeoutMs: 1000 };
  const Construct = PaymentProofs as unknown as new (run: ProofRun, config: ProofConfig, client: AuthenticatedClient, sender: WalletAddress, receiver: WalletAddress) => PaymentProofs;
  const proofs = new Construct(runLike as unknown as ProofRun, config, client, sender, receiver);
  const outgoingGrant = {
    access_token: { value: 'private-token', manage: `${AUTH}/manage-outgoing`, expires_in: 600,
      access: [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER, limits: { debitAmount: zar(budget) } }] },
    continue: { access_token: { value: 'private-continuation' }, uri: `${AUTH}/continue-outgoing` },
  } as unknown as GrantWithAccessToken;
  const spending = await proofs.installOutgoingGrant('offline-exact', outgoingGrant, zar(budget));
  const lifecycle = new OutgoingGrantLifecycle({
    rotateToken: async () => { throw new Error('rotation is not part of this proof'); },
    readSpentAmounts: (args) => client.outgoingPayment.getGrantSpentAmounts(args),
    clock: () => Date.now(), rememberSecret: () => {},
  });
  const initialCounter = await lifecycle.readFreshGrantCounter({ accessToken: spending.grant.access_token.value, budget: spending.budget, resourceServerUrl: RS });
  assert.equal(initialCounter.kind, 'EMPTY');
  const expiry = now + (trip ? 120000 : 30000);
  const preContext: OfflinePreQuoteContext = {
    nowEpochMs: now,
    envelope: { version: '1', envelopeId: 'env', authorizationId: 'grant', ownerUserId: 1, payerWalletId: PAYER,
      deviceId: 'device', deviceKeyVersion: 'key', deviceRevocationVersion: 1, grantRevocationVersion: 1,
      perPaymentMaxDebit: zar(ceiling), cumulativeCap: zar(budget), validFromEpochMs: now - 1000, validUntilEpochMs: expiry, revoked: false, merchantScopeId: RECEIVER },
    grant: { authorizationId: 'grant', userId: 1, status: 'ACTIVE', authorityRef: 'development-only', kind: 'OUTGOING_PAYMENT',
      perPaymentMaxDebit: zar(ceiling), cumulativeCap: zar(budget), cumulativeSpent: zar('0'), validFromEpochMs: now - 1000,
      validUntilEpochMs: spending.expiresAt! - 5000, payerAssetCode: 'ZAR', payerAssetScale: 2, revocationVersion: 1 },
    authority: { ownerUserId: 1, authorizationId: 'grant', payerWalletId: PAYER, usable: true, restrictionsVerified: true,
      snapshotId: 'snapshot', observedAtEpochMs: now, validUntilEpochMs: spending.expiresAt! - 5000,
      cumulativeCap: zar(budget), spentDebit: null, freshGrantEmpty: true },
    device: { ownerUserId: 1, deviceId: 'device', keyVersion: 'key', revocationVersion: 1, active: true, publicKey: keys.publicKey.export({ format: 'jwk' }).x! },
    wallet: { ownerUserId: 1, walletId: PAYER, verified: true },
    merchant: { scopeId: RECEIVER, walletId: RECEIVER, verified: true },
    outstandingReservations: zar('0'),
  };
  const instruction = runOfflineSender({ envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    merchantScopeId: RECEIVER, merchantReceive: eur('10'), maxPayerDebit: zar(ceiling), issuedAtEpochMs: now, expiresAtEpochMs: expiry }, keys.privateKey);
  const merchant = new DevelopmentMerchantAuthenticator(RECEIVER, RECEIVER);
  const reservations = new DevelopmentReservationStore();
  const adapter = createOfflineTestWalletPorts({ proofs, spending, lifecycle, initialCounter, preContext, merchant, reservations });
  return { ports: { ...adapter, evidenceSource: 'SIMULATED' as const }, runLike, instruction, merchant, reservations, calls,
    keys, proofs, spending, lifecycle, initialCounter, preContext };
}

test('offline sender reaches the existing quote, submit and both provider confirmation reads through the simulator adapter', async () => {
  const w = await world();
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'SIMULATED');
  assert.equal(w.calls.quote, 1);
  assert.equal(w.calls.outgoing, 1);
  assert.equal(w.calls.outgoingRead, 1);
  assert.equal(w.calls.incomingRead, 1);
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'CONFIRMED');
  assert.equal(w.runLike.report.payments[0].state, 'SUCCEEDED');
  const replay = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(replay, { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
  assert.equal(w.calls.outgoing, 1);
});

test('merchant-unbound voucher reaches the existing quote and confirmation path without sending merchant details to the offline sender', async () => {
  const w = await world();
  const preContext: OfflinePreQuoteContext = { ...w.preContext, envelope: { ...w.preContext.envelope, merchantScopeId: undefined } };
  const voucher = runOfflineVoucherSender({ envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('200'), issuedAtEpochMs: preContext.nowEpochMs, expiresAtEpochMs: preContext.envelope.validUntilEpochMs }, w.keys.privateKey);
  assert.equal(voucher.payload.merchantScopeId, undefined);
  assert.equal(voucher.payload.exactPurchase, undefined);
  const adapter = createOfflineTestWalletPorts({ proofs: w.proofs, spending: w.spending, lifecycle: w.lifecycle,
    initialCounter: w.initialCounter, preContext, merchant: w.merchant, reservations: w.reservations, mode: 'VOUCHER' });
  const ports = { ...adapter, evidenceSource: 'SIMULATED' as const };
  const result = await executeDevelopmentOfflineVoucher(voucher, w.merchant.credential(), eur('10'), ports);
  assert.equal(result.status, 'SIMULATED');
  assert.equal(w.calls.outgoing, 1);
  assert.equal(w.calls.outgoingRead, 1);
  assert.equal(w.calls.incomingRead, 1);
  const recorded = w.runLike.report.results.offlineVoucher as { counterReadings: { spentDebit: ReturnType<typeof zar> }[] };
  assert.deepEqual(recorded.counterReadings.map((reading) => reading.spentDebit), [zar('186')]);
  assert.deepEqual(await executeDevelopmentOfflineVoucher(voucher, w.merchant.credential(), eur('10'), ports),
    { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
  assert.equal(w.calls.outgoing, 1);
});

test('four offline vouchers reuse one R500 grant, enforce an R50 ceiling and preserve the cumulative counter', async () => {
  const w = await world('four-payments');
  const preContext: OfflinePreQuoteContext = { ...w.preContext, envelope: { ...w.preContext.envelope, merchantScopeId: undefined } };
  const base = { envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('5000'), issuedAtEpochMs: preContext.nowEpochMs, expiresAtEpochMs: preContext.envelope.validUntilEpochMs };
  const vouchers = Array.from({ length: 4 }, () => runOfflineVoucherSender(base, w.keys.privateKey));
  assert.equal(new Set(vouchers.map((entry) => entry.payload.nonce)).size, 4);
  assert.ok(vouchers.every((entry) => entry.payload.merchantScopeId === undefined && entry.payload.maxDebitMinor === '5000'));
  const adapter = createOfflineTestWalletPorts({ proofs: w.proofs, spending: w.spending, lifecycle: w.lifecycle,
    initialCounter: w.initialCounter, preContext, merchant: w.merchant, reservations: w.reservations, mode: 'TRIP' });
  const ports = { ...adapter, evidenceSource: 'SIMULATED' as const };
  const over = runOfflineVoucherSender({ ...base, maxPayerDebit: zar('5001') }, w.keys.privateKey);
  assert.deepEqual(await executeDevelopmentOfflineVoucher(over, w.merchant.credential(), eur('10'), ports),
    { status: 'REJECTED', code: 'OVER_TRANSACTION_CEILING' });
  assert.equal(w.calls.quote, 0);
  for (const voucher of vouchers) {
    assert.equal((await executeDevelopmentOfflineVoucher(voucher, w.merchant.credential(), eur('10'), ports)).status, 'SIMULATED');
  }
  assert.equal(w.calls.outgoing, 4);
  assert.equal(w.calls.quote, 4);
  assert.equal(w.calls.resourceGrants, 2, 'unexpired incoming and quote grants should be reused');
  assert.equal(w.calls.outgoingRead, 4);
  assert.equal(w.calls.incomingRead, 4);
  assert.deepEqual(w.runLike.report.payments.map((payment) => payment.state), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  const report = w.runLike.report.results.offlineTrip as { counterReadings: { spentDebit: ReturnType<typeof zar> }[] };
  assert.deepEqual(report.counterReadings.map((reading) => reading.spentDebit.value), ['186', '372', '558', '744']);
  assert.deepEqual(await executeDevelopmentOfflineVoucher(vouchers[0], w.merchant.credential(), eur('10'), ports),
    { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
  assert.equal(w.calls.outgoing, 4);
});

test('resource-grant failures retain sanitized status without submitting a debit', async () => {
  const w = await world('resource-failure');
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
  assert.equal(w.calls.outgoing, 0);
  const report = w.runLike.report.results.offlineExact as { lastPreparationFailure: Record<string, unknown> };
  assert.deepEqual(report.lastPreparationFailure, { stage: 'INCOMING_GRANT', classification: 'PROVIDER_ERROR', providerStatus: 429, providerCode: 'too_fast' });
  assert.ok(!JSON.stringify(report).includes('private'));
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('pre-submission counter-read failures retain sanitized status without a debit', async () => {
  const w = await world('counter-failure');
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
  assert.equal(w.calls.outgoing, 0);
  const report = w.runLike.report.results.offlineExact as { lastPreparationFailure: Record<string, unknown> };
  assert.deepEqual(report.lastPreparationFailure, { stage: 'COUNTER_READ', classification: 'PROVIDER_ERROR', providerStatus: 403, providerCode: 'request_denied' });
  assert.ok(!JSON.stringify(report).includes('private'));
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('ambiguous outgoing submission stays UNKNOWN and a replay never issues another debit', async () => {
  const w = await world('timeout');
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(w.runLike.report.payments[0].state, 'UNKNOWN');
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'UNKNOWN');
  assert.equal((await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports)).status, 'REJECTED');
  assert.equal(w.calls.outgoing, 1);
});

test('a confirmed-looking provider response with a mismatched counter remains inconclusive', async () => {
  const w = await world('wrong-counter');
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'UNKNOWN');
  assert.equal(w.calls.outgoing, 1);
});

test('a refreshed provider quote above the signed ceiling is rejected before submission', async () => {
  const w = await world('refreshed-over-limit');
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'PAYMENT_NOT_SUBMITTED' });
  assert.equal(w.calls.quote, 2);
  assert.equal(w.calls.outgoing, 0);
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'REJECTED');
});
