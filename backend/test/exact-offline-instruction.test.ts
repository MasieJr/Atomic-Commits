import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import {
  offlineInstructionSigningBytes,
  parseSignedOfflineInstruction,
  verifyOfflineInstructionSignature,
  type OfflineInstructionV1,
} from '../src/domain/payment-engine/signed-offline-instruction';
import { reserveSignedOfflineInstruction, type OfflineRedemptionPorts } from '../src/domain/payment-engine/offline-redemption';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
const receive = { value: '10', assetCode: 'EUR', assetScale: 2 };

function payload(): OfflineInstructionV1 {
  return {
    version: '1', envelopeId: 'env', authorizationId: 'grant', instructionId: 'instruction',
    deviceId: 'device', keyVersion: 'key', nonce: Buffer.from('0123456789abcdef').toString('base64url'),
    issuedAtEpochMs: 1000, expiresAtEpochMs: 10000, assetCode: 'ZAR', assetScale: 2,
    maxDebitMinor: '200', merchantScopeId: 'merchant', exactPurchase: { merchantReceive: receive },
  };
}

function signed(body = payload()) {
  return { payload: body, signature: sign(null, offlineInstructionSigningBytes(body), keys.privateKey).toString('base64url') };
}

test('exact-purchase signature binds merchant, receive amount and payer ceiling', () => {
  const original = signed();
  assert.deepEqual(parseSignedOfflineInstruction(original), original);
  assert.equal(verifyOfflineInstructionSignature(original, publicKey), true);
  for (const altered of [
    { ...original.payload, merchantScopeId: 'other-merchant' },
    { ...original.payload, maxDebitMinor: '201' },
    { ...original.payload, exactPurchase: { merchantReceive: { ...receive, value: '11' } } },
    { ...original.payload, exactPurchase: { merchantReceive: { ...receive, assetCode: 'USD' } } },
    { ...original.payload, exactPurchase: { merchantReceive: { ...receive, assetScale: 3 } } },
  ]) assert.equal(verifyOfflineInstructionSignature({ ...original, payload: altered }, publicKey), false);
});

test('exact purchase requires a merchant and a strictly shaped positive receive amount', () => {
  const instruction = signed();
  const withoutMerchant = { ...instruction.payload } as { merchantScopeId?: string };
  delete withoutMerchant.merchantScopeId;
  assert.equal(parseSignedOfflineInstruction({ ...instruction, payload: withoutMerchant }), undefined);
  for (const invalid of [
    { merchantReceive: { ...receive, value: '0' } },
    { merchantReceive: { ...receive, value: '010' } },
    { merchantReceive: { ...receive, extra: 'untrusted' } },
    { merchantReceive: receive, extra: 'untrusted' },
  ]) assert.equal(parseSignedOfflineInstruction({ ...instruction, payload: { ...instruction.payload, exactPurchase: invalid } }), undefined);
});

test('an exact instruction refuses a different merchant or receive amount before any lookup', async () => {
  let lookups = 0;
  const ports: OfflineRedemptionPorts = {
    loadDeviceEnrollment: async () => { lookups++; return undefined; },
    loadContext: async () => { lookups++; return undefined; },
    nowEpochMs: () => 2000,
    claimAndReserve: async () => { throw new Error('must not claim'); },
  };
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'wrong-merchant', receive, ports), { status: 'REJECTED', code: 'MERCHANT_NOT_VERIFIED' });
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant', { ...receive, value: '11' }, ports), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  assert.deepEqual(await reserveSignedOfflineInstruction(signed(), 'merchant', { ...receive, assetScale: 3 }, ports), { status: 'REJECTED', code: 'INVALID_PAYMENT_REQUEST' });
  assert.equal(lookups, 0);
});

test('existing Errand vouchers remain separate and parse without an exact amount', () => {
  const body = payload();
  const { exactPurchase: _exactPurchase, ...voucher } = body;
  const instruction = signed(voucher);
  assert.deepEqual(parseSignedOfflineInstruction(instruction), instruction);
  assert.equal(verifyOfflineInstructionSignature(instruction, publicKey), true);
  assert.equal(instruction.payload.exactPurchase, undefined);
});
