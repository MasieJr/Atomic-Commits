import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { runOfflineSender, runOfflineVoucherSender } from '../src/dev/offline-sender-process';
import {
  DevelopmentMerchantAuthenticator,
  DevelopmentReservationStore,
  executeDevelopmentOfflinePurchase,
  executeDevelopmentOfflineVoucher,
  type DevelopmentMerchantPorts,
} from '../src/dev/offline-merchant-simulator';
import type { OfflinePolicyContext, OfflinePreQuoteContext } from '../src/domain/payment-engine/offline-spending-policy';
import type { PaymentEvidence } from '../src/services/payment-proof-run';

const NOW = 1_700_000_000_000;
const zar = (value: string) => ({ value, assetCode: 'ZAR', assetScale: 2 });
const eur = (value: string) => ({ value, assetCode: 'EUR', assetScale: 2 });

function world() {
  const keys = generateKeyPairSync('ed25519');
  const senderInput = {
    envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key', merchantScopeId: 'merchant',
    merchantReceive: eur('10'), maxPayerDebit: zar('200'), issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 30000,
  };
  const instruction = runOfflineSender(senderInput, keys.privateKey);
  const merchant = new DevelopmentMerchantAuthenticator('merchant', 'merchant-wallet');
  const reservations = new DevelopmentReservationStore();
  const pre: OfflinePreQuoteContext = {
    nowEpochMs: NOW,
    envelope: {
      version: '1', envelopeId: 'env', authorizationId: 'grant', ownerUserId: 7, payerWalletId: 'payer-wallet',
      deviceId: 'device', deviceKeyVersion: 'key', deviceRevocationVersion: 1, grantRevocationVersion: 1,
      perPaymentMaxDebit: zar('200'), cumulativeCap: zar('600'), validFromEpochMs: NOW - 5000,
      validUntilEpochMs: NOW + 60000, revoked: false, merchantScopeId: 'merchant',
    },
    grant: {
      authorizationId: 'grant', userId: 7, status: 'ACTIVE', authorityRef: 'opaque', kind: 'OUTGOING_PAYMENT',
      perPaymentMaxDebit: zar('200'), cumulativeCap: zar('600'), cumulativeSpent: zar('0'),
      validFromEpochMs: NOW - 5000, validUntilEpochMs: NOW + 60000, payerAssetCode: 'ZAR', payerAssetScale: 2,
      merchantScopeId: 'merchant', receiverBindingId: 'merchant-wallet', revocationVersion: 1,
    },
    authority: {
      ownerUserId: 7, authorizationId: 'grant', payerWalletId: 'payer-wallet', usable: true, restrictionsVerified: true,
      snapshotId: 'snapshot', observedAtEpochMs: NOW - 100, validUntilEpochMs: NOW + 50000,
      cumulativeCap: zar('600'), spentDebit: null, freshGrantEmpty: true,
    },
    device: { ownerUserId: 7, deviceId: 'device', keyVersion: 'key', revocationVersion: 1, active: true, publicKey: keys.publicKey.export({ format: 'jwk' }).x! },
    wallet: { ownerUserId: 7, walletId: 'payer-wallet', verified: true },
    merchant: { scopeId: 'merchant', walletId: 'merchant-wallet', verified: true },
    outstandingReservations: zar('0'),
  };
  let evidence: PaymentEvidence = {
    label: 'offline', state: 'PREPARED', incomingPaymentId: 'incoming', quoteId: 'quote', quotedDebit: zar('186'), quotedReceive: eur('10'),
  };
  const calls: string[] = [];
  const ports: DevelopmentMerchantPorts<string> = {
    evidenceSource: 'SIMULATED', merchant, reservations, nowEpochMs: () => NOW,
    loadDeviceEnrollment: async () => { calls.push('device'); return pre.device; },
    loadPreQuoteContext: async () => { calls.push('context'); return pre; },
    prepareFreshQuote: async (_instruction, _receive, context) => {
      calls.push('quote');
      assert.equal(reservations.state(instruction.payload.nonce), 'RESERVED');
      const quoteContext: OfflinePolicyContext = {
        ...context,
        quote: { quoteId: 'quote', merchantScopeId: 'merchant', payerWalletId: 'payer-wallet', receiverWalletId: 'merchant-wallet', payerDebit: zar('186'), merchantReceive: eur('10'), expiresAtEpochMs: NOW + 10000 },
        expectedMerchantReceive: eur('10'),
      };
      return { prepared: 'prepared', context: quoteContext };
    },
    revalidateGrant: async () => { calls.push('grant'); return true; },
    recordBeforeSubmission: async () => { calls.push('record'); assert.equal(reservations.state(instruction.payload.nonce), 'SUBMITTING'); },
    submitAndConfirm: async (_prepared, remaining, ceiling) => {
      calls.push('submit');
      assert.deepEqual(remaining, zar('600'));
      assert.deepEqual(ceiling, zar('200'));
      evidence = { ...evidence, state: 'SUCCEEDED', outgoingPaymentId: 'outgoing', sentAmount: zar('186'), receivedAmount: eur('10') };
      return evidence;
    },
    currentEvidence: () => evidence,
    reconcileCounter: async () => { calls.push('counter'); return true; },
  };
  return { keys, instruction, merchant, reservations, pre, ports, calls, setEvidence: (value: PaymentEvidence) => { evidence = value; } };
}

test('offline-signed exact purchase reserves before quote and rejects replay without another provider call', async () => {
  const w = world();
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'SIMULATED');
  assert.deepEqual(w.calls, ['device', 'context', 'quote', 'grant', 'record', 'submit', 'counter']);
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'CONFIRMED');
  const replay = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(replay, { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
  assert.equal(w.calls.filter((call) => call === 'quote').length, 1);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('concurrent redemption of the same instruction claims once and submits once', async () => {
  const w = world();
  const results = await Promise.all([
    executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports),
    executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['REJECTED', 'SIMULATED']);
  assert.equal(w.calls.filter((call) => call === 'quote').length, 1);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('unauthenticated merchant, altered signed amount, and voucher do not reach provider or reservation', async () => {
  const w = world();
  assert.deepEqual(await executeDevelopmentOfflinePurchase(w.instruction, Buffer.alloc(32), eur('10'), w.ports), { status: 'REJECTED', code: 'MERCHANT_NOT_VERIFIED' });
  assert.deepEqual(await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('11'), w.ports), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  const tampered = { ...w.instruction, payload: { ...w.instruction.payload, maxDebitMinor: '201' } };
  assert.deepEqual(await executeDevelopmentOfflinePurchase(tampered, w.merchant.credential(), eur('10'), w.ports), { status: 'REJECTED', code: 'DEVICE_NOT_VERIFIED' });
  assert.equal(w.calls.includes('quote'), false);
  assert.equal(w.reservations.state(w.instruction.payload.nonce), undefined);
});

test('expiry, revocation and cumulative budget denial occur before a quote', async () => {
  for (const mutation of ['expired', 'revoked', 'budget'] as const) {
    const w = world();
    w.ports.loadPreQuoteContext = async () => mutation === 'expired' ? { ...w.pre, envelope: { ...w.pre.envelope, validUntilEpochMs: NOW - 1 } } :
      mutation === 'revoked' ? { ...w.pre, device: { ...w.pre.device, active: false } } :
      { ...w.pre, outstandingReservations: zar('600'), authority: { ...w.pre.authority, spentDebit: zar('0'), freshGrantEmpty: false } };
    const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
    assert.equal(result.status, 'REJECTED');
    assert.equal(w.calls.includes('quote'), false);
    assert.equal(w.reservations.state(w.instruction.payload.nonce), undefined);
  }
});

test('an over-ceiling fresh quote releases the reservation without a submission but consumes the nonce', async () => {
  const w = world();
  const original = w.ports.prepareFreshQuote;
  w.ports.prepareFreshQuote = async (...args) => {
    const fresh = await original(...args);
    return { ...fresh, context: { ...fresh.context, quote: { ...fresh.context.quote, payerDebit: zar('201') } } };
  };
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'REJECTED');
  assert.equal(w.calls.includes('submit'), false);
  assert.equal((await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports)).status, 'REJECTED');
});

test('device or grant revocation between reservation and quote stops before submission', async () => {
  for (const revoked of ['device', 'grant'] as const) {
    const w = world();
    const original = w.ports.prepareFreshQuote;
    w.ports.prepareFreshQuote = async (...args) => {
      const fresh = await original(...args);
      return { ...fresh, context: revoked === 'device'
        ? { ...fresh.context, device: { ...fresh.context.device, active: false } }
        : { ...fresh.context, grant: { ...fresh.context.grant, status: 'REVOKED' } } };
    };
    const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
    assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
    assert.equal(w.calls.includes('submit'), false);
    assert.equal(w.reservations.state(w.instruction.payload.nonce), 'REJECTED');
  }
});

test('ambiguous provider outcome retains the reservation and never submits a replay', async () => {
  const w = world();
  w.ports.submitAndConfirm = async () => {
    w.calls.push('submit');
    w.setEvidence({ label: 'offline', state: 'UNKNOWN', incomingPaymentId: 'incoming', quoteId: 'quote', quotedDebit: zar('186'), quotedReceive: eur('10') });
    throw new Error('socket timeout after POST');
  };
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'UNKNOWN');
  assert.deepEqual(w.reservations.withOutstanding(w.pre).outstandingReservations, zar('200'));
  assert.equal((await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports)).status, 'REJECTED');
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('only a confirmed zero-debit failure releases; partial failure stays reserved', async () => {
  for (const sent of ['0', '20']) {
    const w = world();
    w.ports.submitAndConfirm = async () => {
      w.setEvidence({ label: 'offline', state: 'FAILED', incomingPaymentId: 'incoming', quoteId: 'quote', outgoingPaymentId: 'outgoing', quotedDebit: zar('186'), quotedReceive: eur('10'), sentAmount: zar(sent) });
      throw new Error('provider marked payment failed');
    };
    const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
    assert.equal(result.status, sent === '0' ? 'REJECTED' : 'UNKNOWN');
    assert.equal(w.reservations.state(w.instruction.payload.nonce), sent === '0' ? 'REJECTED' : 'UNKNOWN');
    assert.deepEqual(w.reservations.withOutstanding(w.pre).outstandingReservations, zar(sent === '0' ? '0' : '200'));
  }
});

test('missing counter after a provider-reported success remains inconclusive and reserved', async () => {
  const w = world();
  w.ports.reconcileCounter = async () => false;
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(w.reservations.state(w.instruction.payload.nonce), 'UNKNOWN');
  assert.deepEqual(w.reservations.withOutstanding(w.pre).outstandingReservations, zar('200'));
});

test('concurrent different instructions cannot reserve beyond one grant cap', async () => {
  const w = world();
  const pre: OfflinePreQuoteContext = {
    ...w.pre,
    envelope: { ...w.pre.envelope, cumulativeCap: zar('300') },
    grant: { ...w.pre.grant, cumulativeCap: zar('300') },
    authority: { ...w.pre.authority, cumulativeCap: zar('300'), spentDebit: zar('0'), freshGrantEmpty: false },
  };
  w.ports.loadPreQuoteContext = async () => pre;
  w.ports.submitAndConfirm = async (_prepared, remaining, ceiling) => {
    w.calls.push('submit');
    assert.ok(BigInt(remaining.value) >= 200n && BigInt(remaining.value) <= 300n);
    assert.deepEqual(ceiling, zar('200'));
    return { label: 'offline', state: 'SUCCEEDED', incomingPaymentId: 'incoming', quoteId: 'quote', outgoingPaymentId: 'outgoing',
      quotedDebit: zar('186'), quotedReceive: eur('10'), sentAmount: zar('186'), receivedAmount: eur('10') };
  };
  const second = runOfflineSender({ envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key', merchantScopeId: 'merchant',
    merchantReceive: eur('10'), maxPayerDebit: zar('200'), issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 30000 }, w.keys.privateKey);
  const results = await Promise.all([
    executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports),
    executeDevelopmentOfflinePurchase(second, w.merchant.credential(), eur('10'), w.ports),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['REJECTED', 'SIMULATED']);
  assert.equal(w.calls.filter((call) => call === 'submit').length, 1);
});

test('an unbound ceiling voucher can be redeemed by either verified merchant, but only once', async () => {
  const w = world();
  const voucher = runOfflineVoucherSender({ envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('200'), issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 30000 }, w.keys.privateKey);
  assert.equal(voucher.payload.merchantScopeId, undefined);
  assert.equal(voucher.payload.exactPurchase, undefined);
  const setup = (scopeId: string, walletId: string, reservations: DevelopmentReservationStore) => {
    const merchant = new DevelopmentMerchantAuthenticator(scopeId, walletId);
    const pre: OfflinePreQuoteContext = {
      ...w.pre,
      envelope: { ...w.pre.envelope, merchantScopeId: undefined },
      grant: { ...w.pre.grant, merchantScopeId: undefined, receiverBindingId: undefined },
      merchant: { scopeId, walletId, verified: true },
    };
    let submissions = 0;
    const ports: DevelopmentMerchantPorts<string> = {
      ...w.ports, merchant, reservations,
      loadDeviceEnrollment: async () => pre.device,
      loadPreQuoteContext: async () => pre,
      prepareFreshQuote: async (_instruction, _receive, context) => ({ prepared: 'voucher', context: {
        ...context, quote: { quoteId: 'quote', merchantScopeId: scopeId, payerWalletId: 'payer-wallet', receiverWalletId: walletId,
          payerDebit: zar('186'), merchantReceive: eur('10'), expiresAtEpochMs: NOW + 10000 }, expectedMerchantReceive: eur('10'),
      } }),
      recordBeforeSubmission: async () => {},
      submitAndConfirm: async () => { submissions++; return { label: 'voucher', state: 'SUCCEEDED', incomingPaymentId: 'incoming',
        quoteId: 'quote', outgoingPaymentId: 'outgoing', quotedDebit: zar('186'), quotedReceive: eur('10'), sentAmount: zar('186'), receivedAmount: eur('10') }; },
    };
    return { merchant, ports, get submissions() { return submissions; } };
  };
  // Either merchant is eligible when considered independently.
  for (const [scope, wallet] of [['shop-a', 'wallet-a'], ['shop-b', 'wallet-b']]) {
    const scenario = setup(scope, wallet, new DevelopmentReservationStore());
    assert.equal((await executeDevelopmentOfflineVoucher(voucher, scenario.merchant.credential(), eur('10'), scenario.ports)).status, 'SIMULATED');
  }
  // Against the same claim store the first redemption consumes the nonce globally.
  const shared = new DevelopmentReservationStore();
  const first = setup('shop-a', 'wallet-a', shared);
  const second = setup('shop-b', 'wallet-b', shared);
  assert.equal((await executeDevelopmentOfflineVoucher(voucher, first.merchant.credential(), eur('10'), first.ports)).status, 'SIMULATED');
  assert.deepEqual(await executeDevelopmentOfflineVoucher(voucher, second.merchant.credential(), eur('10'), second.ports),
    { status: 'REJECTED', code: 'OFFLINE_CREDENTIAL_ALREADY_CLAIMED' });
  assert.equal(first.submissions, 1);
  assert.equal(second.submissions, 0);
});

test('merchant-provided price cannot produce a payer debit above the signed ceiling', async () => {
  const w = world();
  const voucher = runOfflineVoucherSender({ envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('200'), issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 30000 }, w.keys.privateKey);
  const pre: OfflinePreQuoteContext = { ...w.pre, envelope: { ...w.pre.envelope, merchantScopeId: undefined },
    grant: { ...w.pre.grant, merchantScopeId: undefined, receiverBindingId: undefined } };
  w.ports.loadPreQuoteContext = async () => pre;
  w.ports.prepareFreshQuote = async (_instruction, _receive, context) => ({ prepared: 'voucher', context: {
    ...context, quote: { quoteId: 'quote', merchantScopeId: 'merchant', payerWalletId: 'payer-wallet', receiverWalletId: 'merchant-wallet',
      payerDebit: zar('201'), merchantReceive: eur('10'), expiresAtEpochMs: NOW + 10000 }, expectedMerchantReceive: eur('10'),
  } });
  const result = await executeDevelopmentOfflineVoucher(voucher, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
  assert.equal(w.calls.includes('submit'), false);
});

test('multiple vouchers use one trip budget and automatically reserve only the remaining allowance', async () => {
  const w = world();
  const senderInput = { envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key',
    maxPayerDebit: zar('600'), issuedAtEpochMs: NOW - 1000, expiresAtEpochMs: NOW + 30000 };
  const first = runOfflineVoucherSender(senderInput, w.keys.privateKey);
  const second = runOfflineVoucherSender(senderInput, w.keys.privateKey);
  const reservations = new DevelopmentReservationStore();
  let spent = 0n;
  const ceilings: string[] = [];
  const preContext = (): OfflinePreQuoteContext => ({ ...w.pre,
    envelope: { ...w.pre.envelope, merchantScopeId: undefined, perPaymentMaxDebit: zar('600') },
    grant: { ...w.pre.grant, merchantScopeId: undefined, receiverBindingId: undefined, perPaymentMaxDebit: zar('600'), cumulativeSpent: zar(spent.toString()) },
    authority: { ...w.pre.authority, spentDebit: spent === 0n ? null : zar(spent.toString()), freshGrantEmpty: spent === 0n },
  });
  const ports: DevelopmentMerchantPorts<string> = {
    ...w.ports, reservations,
    loadPreQuoteContext: async () => preContext(),
    prepareFreshQuote: async (_instruction, _receive, context) => ({ prepared: 'voucher', context: {
      ...context, quote: { quoteId: 'quote', merchantScopeId: 'merchant', payerWalletId: 'payer-wallet', receiverWalletId: 'merchant-wallet',
        payerDebit: zar('186'), merchantReceive: eur('10'), expiresAtEpochMs: NOW + 10000 }, expectedMerchantReceive: eur('10'),
    } }),
    recordBeforeSubmission: async () => {},
    submitAndConfirm: async (_prepared, remaining, ceiling) => {
      assert.equal(remaining.value, ceiling.value);
      ceilings.push(ceiling.value);
      spent += 186n;
      return { label: 'voucher', state: 'SUCCEEDED', incomingPaymentId: 'incoming', quoteId: 'quote', outgoingPaymentId: 'outgoing',
        quotedDebit: zar('186'), quotedReceive: eur('10'), sentAmount: zar('186'), receivedAmount: eur('10') };
    },
  };
  assert.equal((await executeDevelopmentOfflineVoucher(first, w.merchant.credential(), eur('10'), ports)).status, 'SIMULATED');
  assert.equal((await executeDevelopmentOfflineVoucher(second, w.merchant.credential(), eur('10'), ports)).status, 'SIMULATED');
  assert.deepEqual(ceilings, ['600', '414']);
  assert.equal(spent, 372n);
});

test('a later release cannot widen the maximum already reserved for a payment', async () => {
  const w = world();
  const pre: OfflinePreQuoteContext = { ...w.pre,
    envelope: { ...w.pre.envelope, cumulativeCap: zar('300') },
    grant: { ...w.pre.grant, cumulativeCap: zar('300') },
    authority: { ...w.pre.authority, cumulativeCap: zar('300'), spentDebit: zar('0'), freshGrantEmpty: false },
  };
  const otherNonce = 'existing-local-reservation';
  assert.equal(w.reservations.claim({ ...w.instruction.payload, nonce: otherNonce }, pre).kind, 'CLAIMED');
  w.ports.loadPreQuoteContext = async () => pre;
  w.ports.prepareFreshQuote = async (_instruction, _receive, context) => {
    // This frees budget after the current claim has reserved only 100.
    w.reservations.finish(otherNonce, 'REJECTED');
    return { prepared: 'prepared', context: { ...context,
      quote: { quoteId: 'quote', merchantScopeId: 'merchant', payerWalletId: 'payer-wallet', receiverWalletId: 'merchant-wallet',
        payerDebit: zar('150'), merchantReceive: eur('10'), expiresAtEpochMs: NOW + 10000 }, expectedMerchantReceive: eur('10') } };
  };
  const result = await executeDevelopmentOfflinePurchase(w.instruction, w.merchant.credential(), eur('10'), w.ports);
  assert.deepEqual(result, { status: 'REJECTED', code: 'QUOTE_OR_GRANT_UNVERIFIABLE' });
  assert.equal(w.calls.includes('submit'), false);
});
