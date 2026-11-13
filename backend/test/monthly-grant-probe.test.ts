import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { OpenPaymentsClientError, type GrantWithAccessToken } from '@interledger/open-payments';
import { monthlyProbeInterval, observeMonthlyGrant, type MonthlyProbePorts } from '../src/dev/monthly-grant-probe';
import { ProofStepError } from '../src/services/payment-proof-run';

const PAYER = 'https://wallet.interledger-test.dev/payer';
const TOKEN = 'SECRET-MONTHLY-ACCESS';
const CONTINUATION = 'SECRET-MONTHLY-CONTINUATION';
const START = new Date('2026-10-28T10:20:30.123Z');
const INTERVAL = 'R1/2026-10-28T10:20:30Z/P1M';
const DEBIT = { value: '1', assetCode: 'ZAR', assetScale: 2 } as const;

function grant(interval: string): GrantWithAccessToken {
  return {
    access_token: {
      value: TOKEN, manage: 'https://auth.interledger-test.dev/token/1', expires_in: 600,
      access: [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER, limits: { debitAmount: { ...DEBIT }, interval } }],
    },
    continue: { access_token: { value: CONTINUATION }, uri: 'https://auth.interledger-test.dev/continue/1' },
  };
}

function harness(options: {
  change?: (value: GrantWithAccessToken) => void;
  counter?: unknown;
  requestFails?: boolean | Error;
  readFails?: boolean;
  cancelFails?: boolean;
} = {}) {
  const calls: string[] = [];
  let issued: GrantWithAccessToken | undefined;
  const ports: MonthlyProbePorts = {
    request: async (interval, amount) => {
      calls.push('request');
      assert.equal(interval, INTERVAL);
      assert.deepEqual(amount, DEBIT);
      if (options.requestFails) throw options.requestFails instanceof Error ? options.requestFails : new Error('private provider error');
      issued = grant(interval);
      options.change?.(issued);
      return issued;
    },
    readSpent: async (token) => {
      calls.push('read');
      assert.equal(token, TOKEN);
      if (options.readFails) throw new Error('private counter error');
      return options.counter ?? { spentDebitAmount: null, spentReceiveAmount: null };
    },
    cancel: async (received) => {
      calls.push('cancel');
      assert.equal(received, issued);
      if (options.cancelFails) throw new Error('private cleanup error');
    },
  };
  return { ports, calls };
}

function entry(value: GrantWithAccessToken): Record<string, unknown> {
  return value.access_token.access[0] as unknown as Record<string, unknown>;
}

test('one-cent monthly probe observes only a matching grant, reads its counter and cancels it', async () => {
  const h = harness();
  const result = await observeMonthlyGrant(h.ports, PAYER, START);
  assert.deepEqual(h.calls, ['request', 'read', 'cancel']);
  assert.deepEqual(result, {
    status: 'OBSERVED', requestedInterval: INTERVAL, requestedDebit: DEBIT,
    request: 'FINALIZED', returnedScope: 'EXACT', returnedInterval: 'MATCH', returnedDebit: 'MATCH',
    counter: 'NULL_PAIR', cancellation: 'CANCELLED',
  });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(CONTINUATION));
});

test('mismatched or incomplete authority is never used to read and is still cancelled', async () => {
  const cases: { change: (value: GrantWithAccessToken) => void; interval: string; debit: string }[] = [
    { change: (g) => { (entry(g).limits as Record<string, unknown>).interval = 'R/2026-10-28T10:20:30Z/P1M'; }, interval: 'DIFFERENT', debit: 'MATCH' },
    { change: (g) => { delete (entry(g).limits as Record<string, unknown>).interval; }, interval: 'MISSING', debit: 'MATCH' },
    { change: (g) => { (entry(g).limits as Record<string, unknown>).debitAmount = { ...DEBIT, value: '2' }; }, interval: 'MATCH', debit: 'DIFFERENT' },
    { change: (g) => { (entry(g).limits as Record<string, unknown>).debitAmount = { ...DEBIT, unknown: 'extra' }; }, interval: 'MATCH', debit: 'DIFFERENT' },
    { change: (g) => { (entry(g).limits as Record<string, unknown>).receiver = 'unexpected'; }, interval: 'MATCH', debit: 'MATCH' },
    { change: (g) => { entry(g).actions = ['create', 'read', 'read-all']; }, interval: 'MATCH', debit: 'MATCH' },
    { change: (g) => { entry(g).identifier = 'another-wallet'; }, interval: 'MATCH', debit: 'MATCH' },
    { change: (g) => { delete g.access_token.expires_in; }, interval: 'MATCH', debit: 'MATCH' },
  ];
  for (const item of cases) {
    const h = harness({ change: item.change });
    const result = await observeMonthlyGrant(h.ports, PAYER, START);
    assert.deepEqual(h.calls, ['request', 'cancel']);
    assert.equal(result.status, 'INCONCLUSIVE');
    assert.equal(result.returnedScope, 'MISMATCH');
    assert.equal(result.returnedInterval, item.interval);
    assert.equal(result.returnedDebit, item.debit);
    assert.equal(result.counter, 'NOT_READ');
    assert.equal(result.cancellation, 'CANCELLED');
  }
});

test('counter observations preserve explicit nulls and reject partial, nonzero or malformed results', async () => {
  const cases: { counter: unknown; expected: string; status: string }[] = [
    { counter: { spentDebitAmount: null, spentReceiveAmount: null }, expected: 'NULL_PAIR', status: 'OBSERVED' },
    { counter: { spentDebitAmount: { ...DEBIT, value: '0' }, spentReceiveAmount: { value: '0', assetCode: 'EUR', assetScale: 2 } }, expected: 'ZERO_DEBIT', status: 'OBSERVED' },
    { counter: { spentDebitAmount: null, spentReceiveAmount: { value: '0', assetCode: 'EUR', assetScale: 2 } }, expected: 'UNVERIFIABLE', status: 'INCONCLUSIVE' },
    { counter: { spentDebitAmount: { ...DEBIT, value: '1' }, spentReceiveAmount: { value: '0', assetCode: 'EUR', assetScale: 2 } }, expected: 'UNVERIFIABLE', status: 'INCONCLUSIVE' },
    { counter: { spentDebitAmount: { ...DEBIT, value: '0' }, spentReceiveAmount: { value: '1', assetCode: 'EUR', assetScale: 2 } }, expected: 'UNVERIFIABLE', status: 'INCONCLUSIVE' },
    { counter: {}, expected: 'UNVERIFIABLE', status: 'INCONCLUSIVE' },
  ];
  for (const item of cases) {
    const h = harness({ counter: item.counter });
    const result = await observeMonthlyGrant(h.ports, PAYER, START);
    assert.equal(result.counter, item.expected);
    assert.equal(result.status, item.status);
    assert.equal(result.cancellation, 'CANCELLED');
    assert.deepEqual(h.calls, ['request', 'read', 'cancel']);
  }
});

test('failed counter reads and cancellation stay inconclusive without exposing provider errors', async () => {
  const failedRead = harness({ readFails: true });
  const readResult = await observeMonthlyGrant(failedRead.ports, PAYER, START);
  assert.equal(readResult.counter, 'UNVERIFIABLE');
  assert.equal(readResult.cancellation, 'CANCELLED');
  assert.deepEqual(failedRead.calls, ['request', 'read', 'cancel']);
  const failedCancel = harness({ cancelFails: true });
  const cancelResult = await observeMonthlyGrant(failedCancel.ports, PAYER, START);
  assert.equal(cancelResult.status, 'INCONCLUSIVE');
  assert.equal(cancelResult.cancellation, 'FAILED');
  assert.ok(!JSON.stringify([readResult, cancelResult]).includes('private'));
});

test('an unconfirmed request never triggers a counter read or claims cancellation', async () => {
  const h = harness({ requestFails: true });
  const result = await observeMonthlyGrant(h.ports, PAYER, START);
  assert.deepEqual(h.calls, ['request']);
  assert.equal(result.request, 'UNCONFIRMED');
  assert.equal(result.cancellation, 'UNKNOWN');
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('provider request rejections retain only safe status and protocol codes', async () => {
  const rejection = new OpenPaymentsClientError('private message', { status: 400, code: 'invalid_request', description: 'private description' });
  const h = harness({ requestFails: new ProofStepError('monthly probe', rejection) });
  const result = await observeMonthlyGrant(h.ports, PAYER, START);
  assert.equal(result.request, 'REJECTED');
  assert.equal(result.providerStatus, 400);
  assert.equal(result.providerCode, 'invalid_request');
  assert.equal(result.cancellation, 'UNKNOWN');
  assert.ok(!JSON.stringify(result).includes('private'));

  const ambiguous = harness({ requestFails: new OpenPaymentsClientError('private', { status: 408, code: 'private-provider-code', description: 'private description' }) });
  const unknown = await observeMonthlyGrant(ambiguous.ports, PAYER, START);
  assert.equal(unknown.request, 'UNCONFIRMED');
  assert.equal(unknown.providerStatus, 408);
  assert.equal(unknown.providerCode, undefined);
});

test('invalid local configuration never reaches the provider ports', async () => {
  const h = harness();
  await assert.rejects(observeMonthlyGrant(h.ports, '', START));
  await assert.rejects(observeMonthlyGrant(h.ports, PAYER, new Date('invalid')));
  assert.throws(() => monthlyProbeInterval(new Date('invalid')));
  assert.deepEqual(h.calls, []);
});

test('default CLI is dry and requires no wallet configuration', () => {
  const tsx = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = resolve(process.cwd(), 'src', 'commands', 'payment-monthly-probe.ts');
  const stdout = execFileSync(process.execPath, [tsx, script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' },
  });
  const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.live, false);
  assert.equal(result.outgoingPayments, 0);
  assert.deepEqual(result.requestedDebit, DEBIT);
});
