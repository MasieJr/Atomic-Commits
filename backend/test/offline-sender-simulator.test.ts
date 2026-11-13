import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { runOfflineSender, runOfflineVoucherSender } from '../src/dev/offline-sender-process';
import { verifyOfflineInstructionSignature } from '../src/domain/payment-engine/signed-offline-instruction';
import { readOfflineProofMoney } from '../src/commands/payment-offline-exact';

const input = {
  envelopeId: 'env', authorizationId: 'grant', deviceId: 'device', keyVersion: 'key', merchantScopeId: 'merchant',
  merchantReceive: { value: '10', assetCode: 'EUR', assetScale: 2 },
  maxPayerDebit: { value: '200', assetCode: 'ZAR', assetScale: 2 },
  issuedAtEpochMs: 1700000000000, expiresAtEpochMs: 1700000060000,
};

test('isolated network-disabled sender produces a valid exact-purchase instruction without exposing its key', () => {
  const keys = generateKeyPairSync('ed25519');
  const first = runOfflineSender(input, keys.privateKey);
  const second = runOfflineSender(input, keys.privateKey);
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
  assert.equal(verifyOfflineInstructionSignature(first, publicKey), true);
  assert.equal(first.payload.merchantScopeId, input.merchantScopeId);
  assert.deepEqual(first.payload.exactPurchase?.merchantReceive, input.merchantReceive);
  assert.equal(first.payload.maxDebitMinor, input.maxPayerDebit.value);
  assert.notEqual(first.payload.nonce, second.payload.nonce);
  assert.notEqual(first.payload.instructionId, second.payload.instructionId);
  assert.ok(!JSON.stringify(first).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(first).includes('access_token'));
});

test('network-disabled sender signs a ceiling voucher without selecting a merchant or price', () => {
  const keys = generateKeyPairSync('ed25519');
  const { merchantScopeId: _merchant, merchantReceive: _price, ...voucherInput } = input;
  const instruction = runOfflineVoucherSender(voucherInput, keys.privateKey);
  assert.equal(verifyOfflineInstructionSignature(instruction, keys.publicKey.export({ format: 'jwk' }).x!), true);
  assert.equal(instruction.payload.merchantScopeId, undefined);
  assert.equal(instruction.payload.exactPurchase, undefined);
  assert.equal(instruction.payload.maxDebitMinor, '200');
  assert.equal(instruction.payload.assetCode, 'ZAR');
  assert.ok(!JSON.stringify(instruction).includes('merchant'));
  assert.ok(!JSON.stringify(instruction).includes('PRIVATE KEY'));
});

test('voucher mode uses one trip budget without asking for a separate checkout ceiling', () => {
  const env: Record<string, string | undefined> = {
    PAYMENT_PROOF_BUDGET_MINOR: '10000', PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR: '10',
    PAYMENT_PROOF_C_PAYER_ASSET_CODE: 'ZAR', PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '2',
    PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE: 'EUR', PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE: '2',
  };
  const config = readOfflineProofMoney(env, 'VOUCHER');
  assert.equal(config.aggregateBudget.value, '10000');
  assert.equal(config.perPaymentMaxDebit.value, '10000');
  assert.equal(env.PAYMENT_PROOF_C_MAX_DEBIT_MINOR, undefined);
  assert.throws(() => readOfflineProofMoney(env, 'EXACT'));
});

test('trip mode preserves an explicit aggregate cap and per-payment cap', () => {
  const config = readOfflineProofMoney({
    PAYMENT_PROOF_BUDGET_MINOR: '50000', PAYMENT_PROOF_C_MAX_DEBIT_MINOR: '5000', PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR: '10',
    PAYMENT_PROOF_C_PAYER_ASSET_CODE: 'ZAR', PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '2',
    PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE: 'EUR', PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE: '2',
  }, 'TRIP');
  assert.equal(config.aggregateBudget.value, '50000');
  assert.equal(config.perPaymentMaxDebit.value, '5000');
});

test('preloaded sender guard blocks common network and subprocess APIs', () => {
  const guard = resolve(process.cwd(), 'dist/src/dev/offline-network-guard.js');
  const fixture = resolve(process.cwd(), 'test/offline-network-guard-fixture.cjs');
  assert.equal(execFileSync(process.execPath, ['--require', guard, fixture], { encoding: 'utf8', timeout: 60000 }), 'blocked');
});

test('sender child refuses to run without the network guard', () => {
  const child = resolve(process.cwd(), 'dist/src/dev/offline-sender-child.js');
  assert.throws(() => execFileSync(process.execPath, [child], { input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
});

test('offline exact command defaults to NOT_RUN without creating a proof record', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'offline-exact-dry-'));
  try {
    const script = resolve(process.cwd(), 'dist/src/commands/payment-offline-exact.js');
    const output = execFileSync(process.execPath, [script], {
      cwd: workdir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    });
    assert.deepEqual(JSON.parse(output).status, 'NOT_RUN');
    assert.equal(existsSync(join(workdir, '.env.payment-proofs')), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('merchant-unbound voucher command defaults to NOT_RUN without a proof record', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'offline-voucher-dry-'));
  try {
    const script = resolve(process.cwd(), 'dist/src/commands/payment-offline-exact.js');
    const output = execFileSync(process.execPath, [script, '--voucher'], {
      cwd: workdir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    });
    const report = JSON.parse(output);
    assert.equal(report.event, 'offline-voucher-proof');
    assert.equal(report.status, 'NOT_RUN');
    assert.equal(existsSync(join(workdir, '.env.payment-proofs')), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('four-payment trip command is dry by default', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'offline-trip-dry-'));
  try {
    const script = resolve(process.cwd(), 'dist/src/commands/payment-offline-exact.js');
    const output = execFileSync(process.execPath, [script, '--trip'], {
      cwd: workdir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    });
    const report = JSON.parse(output);
    assert.equal(report.event, 'offline-trip-proof');
    assert.equal(report.status, 'NOT_RUN');
    assert.equal(report.expectedTransfers, 4);
    assert.equal(existsSync(join(workdir, '.env.payment-proofs')), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
