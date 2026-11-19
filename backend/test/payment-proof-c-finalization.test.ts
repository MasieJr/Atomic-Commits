import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  finalizeProofCRun,
  PROOF_C_CLOSE_ERROR,
  PROOF_C_FINISH_ERROR,
  PROOF_C_SIGNAL_CLEANUP_ERROR,
} from '../src/services/payment-proof-c-finalization';

test('finalization passes the original failure to finish and always closes after a report failure', async () => {
  const original = new Error('the run has an unresolved debit');
  const operations: string[] = [];
  const outcome = await finalizeProofCRun({
    finish: async (failure) => {
      assert.strictEqual(failure, original);
      operations.push('finish');
      throw new Error('secret provider token in disk error');
    },
    close: async () => { operations.push('close'); },
  }, original, () => { operations.push('remove signals'); });
  assert.deepEqual(operations, ['finish', 'remove signals', 'close']);
  assert.deepEqual(outcome, { finishFailed: true, signalCleanupFailed: false, closeFailed: false });
  assert.ok(!JSON.stringify(outcome).includes('secret'));
  assert.match(PROOF_C_FINISH_ERROR, /could not finalize its run report/);
});

test('signal cleanup and lock-release failures remain distinct and never leak details', async () => {
  const operations: string[] = [];
  const outcome = await finalizeProofCRun({
    finish: async () => { operations.push('finish'); },
    close: async () => { operations.push('close'); throw new Error('private lock path'); },
  }, undefined, () => { operations.push('remove signals'); throw new Error('private signal'); });
  assert.deepEqual(operations, ['finish', 'remove signals', 'close']);
  assert.deepEqual(outcome, { finishFailed: false, signalCleanupFailed: true, closeFailed: true });
  assert.ok(!JSON.stringify(outcome).includes('private'));
  assert.match(PROOF_C_SIGNAL_CLEANUP_ERROR, /signal handlers/);
  assert.match(PROOF_C_CLOSE_ERROR, /run lock/);
});

test('successful finalization reports no errors', async () => {
  const outcome = await finalizeProofCRun({ finish: async () => {}, close: async () => {} }, undefined, () => {});
  assert.deepEqual(outcome, { finishFailed: false, signalCleanupFailed: false, closeFailed: false });
});
