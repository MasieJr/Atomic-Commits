import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { OpenPaymentsClientError, type GrantWithAccessToken, type IncomingPayment, type Quote } from '@interledger/open-payments';

import { OutgoingGrantLifecycle, type GrantLifecyclePorts, type OutgoingGrantAuthority } from '../src/services/grant-lifecycle';
import type { ApprovedSpending, PreparedPayment } from '../src/services/payment-proof';
import {
  applyCleanupOutcome,
  cleanupFailedEvidence,
  createProofCPorts,
  PROOF_C_OBSERVATION_MS,
  PROTOCOL_ERROR_CODES,
  readProofCConfig,
  runProofC,
  rotatedApprovedSpending,
  sanitizedProviderCode,
  type ProofCConfig,
  type ProofCEvidence,
  type ProofCPaymentSeams,
  type ProofCPorts,
} from '../src/services/payment-proof-c';
import type { Amount, PaymentEvidence } from '../src/services/payment-proof-run';

// Development-only Test Wallet identifiers; the whole experiment runs with an
// injected fake clock/sleep, fake payment seams and a REAL OutgoingGrantLifecycle
// whose SDK ports are fakes. The production composition (holder swap on rotation,
// authority construction) is the exported createProofCPorts factory exactly as the
// CLI uses it, so stale-token holder bugs are caught here, not pre-fixed.
const BASE = 1_700_000_000_000;
const AUTH = 'https://auth.interledger-test.dev';
const RS = 'https://rs.interledger-test.dev';
const PAYER_ID = 'https://wallet.interledger-test.dev/payer';
const INCOMING_ID = `${RS}/incoming-1`;

const TOKEN_0 = 'AT-PROOF-C-TOKEN-0';
const CONTINUE_TOKEN = 'CONT-PROOF-C-CONTINUE';
const CONTINUE_URI = `${AUTH}/continue/proof-c-grant`;
const tokenAt = (n: number) => `AT-PROOF-C-TOKEN-${n}`;
// per guidance the rotation path segment is deliberately not 'token'
const manageAt = (n: number) => `${AUTH}/grant/rotation-${n}`;

const BUDGET: Amount = { value: '50000', assetCode: 'USD', assetScale: 2 };
const CEILING: Amount = { value: '15000', assetCode: 'USD', assetScale: 2 };
const RECEIVE: Amount = { value: '1000', assetCode: 'USD', assetScale: 2 };
const DEBIT: Amount = { value: '10000', assetCode: 'USD', assetScale: 2 };

interface RotationRecord { url: string; accessToken: string }
interface PayCallRecord {
  label: string;
  token: string;
  manageUrl: string;
  expiresAt: number | undefined;
  budget: Amount;
  remaining: Amount;
  ceiling: Amount | undefined;
}

interface CWorld {
  config: ProofCConfig;
  ports: ProofCPorts;
  lifecycle: OutgoingGrantLifecycle;
  clock: { value: number };
  sleeps: number[];
  authorizeCalls: Amount[];
  refreshCalls: number;
  prepares: string[];
  payCalls: PayCallRecord[];
  rotations: RotationRecord[];
  lifecycleCounterReads: RotationRecord[];
  remembered: string[];
  grantHandles: { continueToken: string; continueUri: string }[];
  cumulative: bigint;
}

interface CWorldOptions {
  lifetimeMs?: number;                      // advertised token lifetime; drives spending.expiresAt and rotation expires_in
  marginMs?: number;                        // rotationEarlyMarginMs
  counterSettleMs?: number;
  counterPollIntervalMs?: number;
  readings?: bigint[];                      // scripted provider counter readings; the last repeats
  counterFailure?: Error;                   // counter read fails before any debit
  emptyCounterReads?: number;               // explicit provider null/null for first N reads
  rotationFailures?: Error[];               // queued errors the fake token.rotate throws
  rotatedTokens?: { value: string; manage: string }[]; // scripted rotated token responses
  abortSleep?: number;                      // fake sleep rejects when asked for exactly this many ms
  quoteDebit?: Amount;                      // default DEBIT; asset-change tests override
  payBehavior?: (world: CWorld, index: number, payment: PreparedPayment, spending: ApprovedSpending) => Promise<PaymentEvidence>;
  preReauth?: boolean;                      // flag the real lifecycle with markReauthRequired before the run
}

// the standard fake pay: the debit landed at the provider and the payment succeeded
async function defaultSuccessfulPay(world: CWorld, index: number, payment: PreparedPayment): Promise<PaymentEvidence> {
  const call = world.payCalls[world.payCalls.length - 1];
  // the current token is whatever the last confirmed rotation installed; payments
  // between rotations legitimately reuse it (e.g. a long-lived token lifetime)
  const expected = tokenAt(world.rotations.length);
  if (call.token !== expected) {
    throw new Error(`stale-token: payment ${index} reached the provider with ${call.token} instead of ${expected}`);
  }
  world.cumulative += BigInt(payment.quote.debitAmount.value);
  return {
    label: payment.evidence.label,
    state: 'SUCCEEDED',
    incomingPaymentId: INCOMING_ID,
    quoteId: payment.quote.id,
    quotedDebit: payment.quote.debitAmount,
    quotedReceive: payment.quote.receiveAmount,
    outgoingPaymentId: `${RS}/outgoing-${index}`,
    sentAmount: payment.quote.debitAmount,
    receivedAmount: payment.quote.receiveAmount,
  };
}

function makeCWorld(opts: CWorldOptions = {}): CWorld {
  const lifetimeMs = opts.lifetimeMs ?? 600_000;
  const clock = { value: BASE };
  const world: CWorld = {
    config: {
      aggregateBudget: { ...BUDGET },
      perPaymentMaxDebit: { ...CEILING },
      receiveAmount: { ...RECEIVE },
      rotationEarlyMarginMs: opts.marginMs ?? 60_000,
      counterSettleMs: opts.counterSettleMs ?? 120_000,
      counterPollIntervalMs: opts.counterPollIntervalMs ?? 1_000,
    },
    ports: undefined as never,
    lifecycle: undefined as never,
    clock,
    sleeps: [],
    authorizeCalls: [],
    refreshCalls: 0,
    prepares: [],
    payCalls: [],
    rotations: [],
    lifecycleCounterReads: [],
    remembered: [],
    grantHandles: [],
    cumulative: 0n,
  };
  let authTokenIndex = 0; // rotation responses hand out TOKEN_1, TOKEN_2, ... in order

  // scripted provider counter readings: default = the live ledger the fake pay updates
  let readingCursor = 0;
  const nextReading = (): bigint => {
    if (opts.readings !== undefined) {
      const value = opts.readings[Math.min(readingCursor, opts.readings.length - 1)];
      readingCursor += 1;
      return value;
    }
    return world.cumulative;
  };

  // real lifecycle over faked SDK seams
  const sdkPorts: GrantLifecyclePorts = {
    rotateToken: async (args) => {
      world.rotations.push(args);
      if (opts.rotationFailures && opts.rotationFailures.length > 0) throw opts.rotationFailures.shift() as Error;
      if (opts.rotatedTokens && opts.rotatedTokens.length > 0) {
        // scripted response: the token value and manage URI are handed out verbatim,
        // including deviant ones (already-consumed values, repeated manage URIs)
        return { access_token: { ...opts.rotatedTokens.shift()!, expires_in: lifetimeMs / 1000, access: [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER_ID, limits: { debitAmount: { ...BUDGET } } }] } } as unknown as never;
      }
      const n = ++authTokenIndex;
      return {
        access_token: {
          value: tokenAt(n),
          manage: manageAt(n),
          expires_in: lifetimeMs / 1000,
          access: [{
            type: 'outgoing-payment',
            actions: ['create', 'read'],
            identifier: PAYER_ID,
            limits: { debitAmount: { ...BUDGET } },
          }],
        },
      } as unknown as never;
    },
    readSpentAmounts: async (args) => {
      world.lifecycleCounterReads.push(args);
      if (opts.counterFailure) throw opts.counterFailure;
      if (world.lifecycleCounterReads.length <= (opts.emptyCounterReads ?? 0)) {
        return { spentDebitAmount: null, spentReceiveAmount: null } as never;
      }
      const value = nextReading();
      return { spentDebitAmount: { value: value.toString(), assetCode: 'USD', assetScale: 2 } } as never;
    },
    clock: () => clock.value,
    rememberSecret: (value: string) => {
      if (value) world.remembered.push(value);
    },
  };
  const lifecycle = new OutgoingGrantLifecycle(sdkPorts);
  if (opts.preReauth) lifecycle.markReauthRequired();

  const payments = {
    sender: { id: PAYER_ID, resourceServer: RS },
    authorize: async (proof: string, budget: Amount): Promise<ApprovedSpending> => {
      assert.equal(proof, 'C', 'the authorize seam carries the proof-C identifier');
      world.authorizeCalls.push({ ...budget });
      const spending: ApprovedSpending = {
        grant: {
          access_token: {
            value: TOKEN_0,
            manage: manageAt(0),
            expires_in: lifetimeMs / 1000,
            access: [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER_ID, limits: { debitAmount: { ...budget } } }],
          },
          continue: { access_token: { value: CONTINUE_TOKEN }, uri: CONTINUE_URI },
        } as unknown as GrantWithAccessToken,
        budget: { ...budget },
        expiresAt: BASE + lifetimeMs,
      };
      world.grantHandles.push({ continueToken: CONTINUE_TOKEN, continueUri: CONTINUE_URI });
      return spending;
    },
    refreshResourceGrants: async () => {
      world.refreshCalls += 1;
    },
    prepare: async (label: string): Promise<PreparedPayment> => {
      world.prepares.push(label);
      const debit = opts.quoteDebit ?? DEBIT;
      const quote = {
        id: `${RS}/quotes/${label}`,
        walletAddress: PAYER_ID,
        debitAmount: debit,
        receiveAmount: { ...RECEIVE },
      } as unknown as Quote;
      return {
        incoming: { id: INCOMING_ID } as unknown as IncomingPayment,
        quote,
        evidence: {
          label,
          state: 'PREPARED',
          incomingPaymentId: INCOMING_ID,
          quoteId: String(quote.id),
          quotedDebit: quote.debitAmount,
          quotedReceive: quote.receiveAmount,
        },
      };
    },
    pay: async (payment: PreparedPayment, spending: ApprovedSpending, remaining: Amount, ceiling?: Amount): Promise<PaymentEvidence> => {
      const index = Number(/C-payment-(\d)/.exec(payment.evidence.label)?.[1]);
      world.payCalls.push({
        label: payment.evidence.label,
        token: spending.grant.access_token.value,
        manageUrl: spending.grant.access_token.manage,
        expiresAt: spending.expiresAt,
        budget: { ...spending.budget },
        remaining: { ...remaining },
        ceiling: ceiling === undefined ? undefined : { ...ceiling },
      });
      const behavior = opts.payBehavior ?? ((w: CWorld, i: number, p: PreparedPayment) => defaultSuccessfulPay(w, i, p));
      return behavior(world, index, payment, spending);
    },
  };

  world.lifecycle = lifecycle;
  world.ports = createProofCPorts(
    () => clock.value,
    async (ms) => {
      if (opts.abortSleep !== undefined && ms === opts.abortSleep) throw new Error('operator abort');
      world.sleeps.push(ms);
      clock.value += ms;
    },
    payments as unknown as ProofCPaymentSeams,
    lifecycle,
  );
  return world;
}

async function expectOutcome(promise: Promise<unknown>, expect: { status: string; reason?: RegExp }): Promise<ProofCEvidence> {
  const evidence = await promise as ProofCEvidence;
  assert.equal(evidence.status, expect.status, `status was ${evidence.status}: ${evidence.reason}`);
  if (expect.reason) assert.match(evidence.reason, expect.reason, `reason was: ${evidence.reason}`);
  return evidence;
}

function assertNoSpendingSecrets(evidence: unknown): void {
  const json = JSON.stringify(evidence);
  for (const secret of [TOKEN_0, tokenAt(1), tokenAt(2), CONTINUE_TOKEN, CONTINUE_URI, manageAt(0), manageAt(1), manageAt(2)]) {
    assert.ok(!json.includes(secret), 'evidence carries a raw grant secret or rotation URL');
  }
}

// ---- the headline positive path ----

test('proof C confirms three payments across two rotations on one consent', async () => {
  const world = makeCWorld();
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'PASSED',
    reason: /Three transfers confirmed/,
  });
  assert.equal(evidence.interactiveApprovals, 1);
  assert.equal(evidence.payerInteractions, 1);
  assert.equal(evidence.intendedTransfers, 3);
  assert.equal(evidence.executedTransfers, 3);
  assert.equal(evidence.confirmedTransfers, 3);
  assert.equal(evidence.rotationsAttempted, 2);
  assert.equal(evidence.rotationsConfirmed, 2);
  assert.equal(evidence.paymentAfterOriginalExpiryConfirmed, true);
  assert.equal(evidence.paymentAfterMinute25Confirmed, true);
  assert.equal(evidence.providerSpentCounterConsistent, true);
  assert.equal(evidence.grantRestrictionsPreserved, true);
  assert.equal(evidence.originalAccessTokenLifetimeSeconds, 600);
  assert.equal(evidence.observationMs, PROOF_C_OBSERVATION_MS);
  assert.equal(world.authorizeCalls.length, 1, 'a second interactive approval was requested');
  assert.deepEqual(world.authorizeCalls[0], { ...BUDGET });
  assert.deepEqual(world.prepares, ['C-payment-1', 'C-payment-2', 'C-payment-3']);
  assert.equal(world.refreshCalls, 3);

  // submission timeline exactly on the scheduled gates
  assert.deepEqual(evidence.transfers.map((t) => t.submittedAt), [BASE, BASE + 600_001, BASE + 25 * 60 * 1000 + 1]);
  assert.deepEqual(evidence.transfers.map((t) => t.state), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  assert.deepEqual(evidence.counterReadings.map((r) => r.value), ['0', '0', '10000', '10000', '20000', '20000', '30000']);
  assert.deepEqual(evidence.rotationCounterObservations.map((r) => [r.rotationAttempt, r.phase, r.spentDebit.value]), [
    [1, 'BEFORE', '10000'], [1, 'AFTER', '10000'], [2, 'BEFORE', '20000'], [2, 'AFTER', '20000'],
  ]);

  // pay always used the CURRENT (post-rotation) authority, never the stale token
  assert.deepEqual(world.payCalls.map((c) => c.token), [TOKEN_0, tokenAt(1), tokenAt(2)]);
  assert.deepEqual(world.payCalls.map((c) => c.manageUrl), [manageAt(0), manageAt(1), manageAt(2)]);
  // conservative request-anchored expiries, not re-derived ones
  assert.deepEqual(world.payCalls.map((c) => c.expiresAt), [BASE + 600_000, BASE + 540_000 + 600_000, BASE + 1_080_000 + 600_000]);
  // the cap stayed identical and each call carried remaining allowance AND the ceiling
  assert.deepEqual(world.payCalls.map((c) => c.budget), [{ ...BUDGET }, { ...BUDGET }, { ...BUDGET }]);
  assert.deepEqual(world.payCalls.map((c) => c.remaining), [
    { ...BUDGET },
    { ...BUDGET, value: '40000' },
    { ...BUDGET, value: '30000' },
  ]);
  assert.deepEqual(world.payCalls.map((c) => c.ceiling), [{ ...CEILING }, { ...CEILING }, { ...CEILING }]);

  // rotations went through the current manages with the current tokens
  assert.deepEqual(world.rotations, [
    { url: manageAt(0), accessToken: TOKEN_0 },
    { url: manageAt(1), accessToken: tokenAt(1) },
  ]);
  // the original grant continuation stays untouched for cleanup
  assert.deepEqual(world.grantHandles, [{ continueToken: CONTINUE_TOKEN, continueUri: CONTINUE_URI }]);
  // rotation endpoints stayed inside the supported namespace, never a '/token/' path
  assert.ok(world.rotations.every((r) => !r.url.includes('/token/')));
  assertNoSpendingSecrets(evidence);
  assert.deepEqual(evidence.lifecycleFailures, []);
});

// ---- classification of pre/post debit outcomes ----

test('a nonzero initial counter fails the run before any debit', async () => {
  const world = makeCWorld({ readings: [50n] });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /already reports nonzero spending/,
  });
  assert.equal(evidence.executedTransfers, 0);
  assert.equal(evidence.transfers.length, 0);
  assert.equal(world.payCalls.length, 0);
  assert.equal(evidence.providerSpentCounterConsistent, false);
  assert.equal(evidence.grantRestrictionsPreserved, false);
});

test('a fresh null/null counter permits only a bounded first debit until numeric reconciliation', async () => {
  const world = makeCWorld({ emptyCounterReads: 1 });
  const evidence = await runProofC(world.config, world.ports);
  assert.equal(evidence.status, 'PASSED');
  assert.equal(evidence.initialCounterObservation, 'EMPTY_NULLS');
  assert.equal(evidence.emptyInitialCounterReconciled, true);
  assert.equal(evidence.counterReadings[0].value, '10000', 'null was incorrectly recorded as numeric zero');
  assert.equal(evidence.confirmedTransfers, 3);
  assert.equal(evidence.rotationsConfirmed, 2);
  assertNoSpendingSecrets(evidence);
});

test('a counter still absent after the first debit stops before any rotation or second debit', async () => {
  const world = makeCWorld({ emptyCounterReads: 2 });
  const evidence = await runProofC(world.config, world.ports);
  assert.equal(evidence.status, 'INCONCLUSIVE');
  assert.equal(evidence.initialCounterObservation, 'EMPTY_NULLS');
  assert.equal(evidence.emptyInitialCounterReconciled, false);
  assert.equal(evidence.executedTransfers, 1);
  assert.equal(world.payCalls.length, 1);
  assert.equal(evidence.rotationsAttempted, 0);
  assert.equal(evidence.lifecycleFailures[0].counterReason, 'MISSING_COUNTER');
});

test('an initial counter read failure records safe diagnostics and stops before a debit', async () => {
  const world = makeCWorld({ counterFailure: new OpenPaymentsClientError('private failure', {
    status: 403, code: 'private-code', description: 'private provider text',
  }) });
  const evidence = await runProofC(world.config, world.ports);
  assert.equal(evidence.status, 'INCONCLUSIVE');
  assert.equal(evidence.executedTransfers, 0);
  assert.equal(world.payCalls.length, 0);
  assert.deepEqual(evidence.lifecycleFailures, [{
    category: 'UNVERIFIABLE_COUNTER', classification: 'UNKNOWN_OUTCOME', providerStatus: 403, counterReason: 'READ_FAILED',
  }]);
  assert.deepEqual(evidence.counterReadings, []);
  assert.deepEqual(evidence.rotationCounterObservations, []);
  assert.ok(!JSON.stringify(evidence).includes('private'));
  assertNoSpendingSecrets(evidence);
});

test('post-POST UNKNOWN outcomes count the execution without a second debit', async () => {
  const world = makeCWorld({
    payBehavior: async (_world, index, payment) => {
      if (index >= 1) {
        payment.evidence.state = 'UNKNOWN';
        throw new Error('socket cut mid-submission');
      }
      return defaultSuccessfulPay(_world, index, payment);
    },
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /outcome is UNKNOWN/,
  });
  assert.equal(evidence.executedTransfers, 1);
  assert.equal(evidence.transfers.length, 1);
  assert.equal(evidence.transfers[0].state, 'UNKNOWN');
  assert.equal(world.payCalls.length, 1, 'a second debit was attempted after the unknown outcome');
  assert.equal(evidence.providerSpentCounterConsistent, false);
});

test('a refusal before any debit is definitive and records no execution', async () => {
  const world = makeCWorld({
    payBehavior: async () => {
      throw new Error('ceiling refused the quote before any debit');
    },
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /stopped before any provider debit/,
  });
  assert.equal(evidence.executedTransfers, 0);
  assert.equal(evidence.transfers.length, 0);
});

test('a definitively failed transfer is classified FAILED, an uncertain one INCONCLUSIVE', async () => {
  const failed = makeCWorld({
    payBehavior: async (w, index, payment) => {
      const result = await defaultSuccessfulPay(w, index, payment); // spent went up at the provider anyway
      payment.evidence.state = 'FAILED';
      return { ...result, state: 'FAILED' };
    },
  });
  const evidenceFailed = await expectOutcome(runProofC(failed.config, failed.ports), {
    status: 'FAILED',
    reason: /definitively did not complete/,
  });
  assert.equal(evidenceFailed.executedTransfers, 1);
  assert.equal(evidenceFailed.transfers[0].state, 'FAILED');

  const unknown = makeCWorld({
    payBehavior: async (w, index, payment) => {
      const result = await defaultSuccessfulPay(w, index, payment);
      return { ...result, state: 'UNKNOWN' as const };
    },
  });
  const evidenceUnknown = await expectOutcome(runProofC(unknown.config, unknown.ports), {
    status: 'INCONCLUSIVE',
    reason: /outcome is UNKNOWN/,
  });
  assert.equal(evidenceUnknown.executedTransfers, 1);
});

// ---- provider counter honesty ----

test('a counter reset below its high-water mark fails even before recovery', async () => {
  const world = makeCWorld({ readings: [0n, 0n, 4000n, 2000n] });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /counter decreased between readings/,
  });
  assert.deepEqual(evidence.counterReadings.map((r) => r.value), ['0', '0', '4000', '2000']);
});

test('a counter overshoot over the confirmed total fails immediately', async () => {
  // 20000 exceeds the confirmed cumulative (10000) but stays under the accepted
  // budget cap (50000), so the runner's own check (not the lifecycle poison) fires
  const world = makeCWorld({ readings: [0n, 0n, 20000n] });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /exceeds the confirmed transfers/,
  });
  assert.equal(evidence.executedTransfers, 1);
  assert.equal(evidence.confirmedTransfers, 1);
});

test('counter polling is bounded and exhausts to INCONCLUSIVE', async () => {
  const world = makeCWorld({ counterSettleMs: 200, counterPollIntervalMs: 100, readings: [0n, 0n] });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /did not confirm the settled amounts within the bounded window/,
  });
  assert.ok(world.sleeps.filter((ms) => ms === 100).length >= 2, 'the runner really waited between polls');
  assert.equal(evidence.executedTransfers, 1);
  assert.equal(evidence.confirmedTransfers, 1);
});

// ---- quote scope honesty ----

test('a provider quote in a different payer asset fails before any debit', async () => {
  const world = makeCWorld({ quoteDebit: { ...DEBIT, assetCode: 'EUR' } });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /different payer asset/,
  });
  assert.equal(evidence.executedTransfers, 0);
  assert.equal(world.payCalls.length, 0);
});

// ---- rotation scheduling and lifecycle failures ----

test('a token lifetime without usable rotation margin stops without a fresh approval', async () => {
  const world = makeCWorld({ lifetimeMs: 30_000 });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /no usable rotation margin/,
  });
  assert.equal(world.authorizeCalls.length, 1);
  assert.equal(evidence.rotationsAttempted, 0);
  assert.equal(world.payCalls.length, 0);
  assert.equal(evidence.rotationsConfirmed, 0);
});

test('a definitive rotation refusal fails the run and keeps the whitelisted provider code', async () => {
  const world = makeCWorld({
    rotationFailures: [new OpenPaymentsClientError('rotation refused', { description: 'nope', status: 404, code: 'invalid_rotation' })],
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /definitively refused a required token rotation/,
  });
  assert.deepEqual(evidence.lifecycleFailures, [{
    category: 'ROTATION_REJECTED',
    classification: 'DEFINITIVE_PROVIDER_REJECTION',
    providerStatus: 404,
    providerCode: 'invalid_rotation', // whitelisted protocol enum is retained on purpose
  }]);
  assert.equal(world.authorizeCalls.length, 1, 'consent happened exactly once');
  assert.equal(evidence.rotationsAttempted, 1);
  assert.deepEqual(evidence.rotationCounterObservations.map((r) => r.phase), ['BEFORE']);
  assert.equal(evidence.rotationEarlyMarginMs, 60_000);
  assert.equal(evidence.providerSpentCounterConsistent, false);
  assertNoSpendingSecrets(evidence);
});

test('an arbitrary provider code text is omitted from lifecycle evidence', async () => {
  const world = makeCWorld({
    rotationFailures: [new OpenPaymentsClientError('rotation refused', { description: 'node flapping again: some-random-text-42', status: 404, code: 'some-random-text-42' })],
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'FAILED',
    reason: /definitively refused a required token rotation/,
  });
  assert.deepEqual(evidence.lifecycleFailures, [{
    category: 'ROTATION_REJECTED',
    classification: 'DEFINITIVE_PROVIDER_REJECTION',
    providerStatus: 404,
  }]);
  const json = JSON.stringify(evidence);
  assert.ok(!json.includes('some-random-text-42'), 'free-form provider code text leaked into evidence');
  assert.ok(!json.includes('node flapping'), 'provider description text leaked into evidence');
});

test('an ambiguous rotation outcome stays INCONCLUSIVE with no invented detail', async () => {
  const world = makeCWorld({
    rotationFailures: [new OpenPaymentsClientError('request timed out', { description: 'timed out', status: 408 })],
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /Lifecycle verification could not confirm/,
  });
  assert.deepEqual(evidence.lifecycleFailures, [{ category: 'AMBIGUOUS_ROTATION', classification: 'UNKNOWN_OUTCOME' }]);
  assert.equal(evidence.rotationsConfirmed, 0);
  assertNoSpendingSecrets(evidence);
});

test('pending reauth stops the run before counter work; no fresh approval is requested', async () => {
  const world = makeCWorld({ preReauth: true });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /Lifecycle verification could not confirm/,
  });
  assert.deepEqual(evidence.lifecycleFailures, [{ category: 'REAUTH_REQUIRED' }]);
  assert.equal(evidence.interactiveApprovals, 1);
  assert.equal(world.authorizeCalls.length, 1);
  assert.equal(evidence.counterReadings.length, 0, 'counter readings ran despite pending reauth');
  assert.equal(evidence.rotationsAttempted, 0);
});

test('a long-lived token still rotates for the deadline gates; one rotation cannot certify the window', async () => {
  // lifetime 3_000_000ms: payment 2's gate (original expiry + 1ms) lies inside the
  // rotation margin, so exactly one rotation happens before it; a second does not
  // (the rotated expiry BASE+2_940_000+3_000_000 is far beyond every later target)
  const world = makeCWorld({ lifetimeMs: 3_000_000 });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /Fewer than two pre-expiry rotations/,
  });
  assert.equal(evidence.executedTransfers, 3);
  assert.equal(evidence.confirmedTransfers, 3);
  assert.equal(evidence.rotationsAttempted, 1);
  assert.equal(evidence.rotationsConfirmed, 1);
  assert.equal(world.rotations.length, 1);
  // rotation before gate 2, then the rotated authority serves gates 2 and 3
  assert.deepEqual(world.rotations, [{ url: manageAt(0), accessToken: TOKEN_0 }]);
  assert.deepEqual(world.payCalls.map((c) => c.manageUrl), [manageAt(0), manageAt(1), manageAt(1)]);
  // no rotation, so every payment used the original authority; cap stayed exact
  assert.deepEqual(world.payCalls.map((c) => c.token), [TOKEN_0, tokenAt(1), tokenAt(1)]);
  assert.deepEqual(world.payCalls.map((c) => c.budget), [{ ...BUDGET }, { ...BUDGET }, { ...BUDGET }]);
  assert.deepEqual(world.payCalls.map((c) => c.remaining), [
    { ...BUDGET },
    { ...BUDGET, value: '40000' },
    { ...BUDGET, value: '30000' },
  ]);
  assert.equal(evidence.paymentAfterMinute25Confirmed, true);
  assert.equal(evidence.providerSpentCounterConsistent, false);
});

// ---- rotated-response identity and canonical holder swap (L2 review additions) ----

test('a rotation response returning an already-consumed token poisons before the post-rotation read', async () => {
  // lifetime 400_000ms fires three rotations before the payment gates; the third
  // response re-hands TOKEN_0, consumed by the first rotation two rotations ago
  const world = makeCWorld({
    lifetimeMs: 400_000,
    rotatedTokens: [
      { value: tokenAt(1), manage: manageAt(1) },
      { value: tokenAt(2), manage: manageAt(2) },
      { value: TOKEN_0, manage: manageAt(3) },
    ],
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /Lifecycle verification could not confirm/,
  });
  // the reused value was registered for redaction before classification, then the
  // lifecycle poisoned: no fifth lifecycle run, no post-rotation counter read, no debit
  assert.ok(world.remembered.includes(TOKEN_0), 'the reused value was not registered for redaction');
  assert.deepEqual(evidence.lifecycleFailures, [{ category: 'AMBIGUOUS_ROTATION' }], 'an invented detail was copied into the evidence');
  assert.equal(evidence.rotationsAttempted, 3);
  assert.equal(evidence.rotationsConfirmed, 2);
  assert.equal(evidence.executedTransfers, 2, 'a third payment ran after the poisoned rotation');
  assert.deepEqual(world.payCalls.map((c) => c.token), [TOKEN_0, tokenAt(1)]);
  assert.deepEqual(evidence.counterReadings.map((r) => r.value), ['0', '0', '10000', '10000', '20000'], 'a counter read followed the poisoned rotation');
  assert.equal(world.authorizeCalls.length, 1, 'a second consent was requested');
  assert.equal(evidence.confirmedTransfers, 2);
});

test('a rotation that returns the same manage URI with a genuinely new token is accepted', async () => {
  // both rotated responses keep the original manage URI; only the token value changes
  const world = makeCWorld({
    rotatedTokens: [
      { value: tokenAt(1), manage: manageAt(0) },
      { value: tokenAt(2), manage: manageAt(0) },
    ],
  });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'PASSED',
    reason: /Three transfers confirmed/,
  });
  assert.equal(evidence.rotationsAttempted, 2);
  assert.equal(evidence.rotationsConfirmed, 2);
  // every rotation and every payment went through the unchanged manage URI,
  // with strictly progressive token values (never a consumed one)
  assert.deepEqual(world.rotations.map((r) => r.url), [manageAt(0), manageAt(0)]);
  assert.deepEqual(world.rotations.map((r) => r.accessToken), [TOKEN_0, tokenAt(1)]);
  assert.deepEqual(world.payCalls.map((c) => c.manageUrl), [manageAt(0), manageAt(0), manageAt(0)]);
  assert.deepEqual(world.payCalls.map((c) => c.token), [TOKEN_0, tokenAt(1), tokenAt(2)]);
  assertNoSpendingSecrets(evidence);
});

test('rotatedApprovedSpending swaps the holder canonically and keeps the original continuation', () => {
  const originalAccess = [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER_ID, limits: { debitAmount: { ...BUDGET } } }];
  const previous: ApprovedSpending = {
    grant: {
      access_token: { value: TOKEN_0, manage: manageAt(0), expires_in: 600, access: originalAccess } as never,
      continue: { access_token: { value: CONTINUE_TOKEN }, uri: CONTINUE_URI },
    } as unknown as GrantWithAccessToken,
    budget: { ...BUDGET },
    expiresAt: BASE + 600_000,
  };
  const authority = {
    accessToken: tokenAt(1),
    manageUrl: manageAt(1),
    budget: { ...BUDGET },
    expiresAt: BASE + 1_140_000,
    payerId: PAYER_ID,
    resourceServerUrl: RS,
  } as OutgoingGrantAuthority;

  const rotated = rotatedApprovedSpending(previous, authority);
  // stale token value/advertised lifetime replaced by the rotated authority's own
  assert.deepEqual(rotated.grant.access_token, { value: tokenAt(1), manage: manageAt(1), access: previous.grant.access_token.access });
  assert.ok(!('expires_in' in (rotated.grant.access_token as Record<string, unknown>)), 'the stale advertised lifetime survived the swap');
  // lasting metadata survives the swap unchanged
  assert.deepEqual(rotated.grant.access_token.access, originalAccess);
  assert.equal(rotated.grant.continue, previous.grant.continue, 'the original grant continuation was replaced');
  // the cap and the conservative request-anchored deadline come from the authority itself
  assert.equal(rotated.budget, authority.budget, 'the accepted cap was re-derived');
  assert.equal(rotated.expiresAt, BASE + 1_140_000, 'the deadline came from the previous authority instead of the rotated one');
  const json = JSON.stringify(rotated);
  assert.ok(!json.includes(TOKEN_0), 'the stale token value survives in the rotated spending');
  assert.ok(!json.includes(manageAt(0)), 'the stale manage URI survives in the rotated spending');

  // a rotated response without a usable token/manage can never install a holder
  assert.throws(
    () => rotatedApprovedSpending(previous, { ...authority, accessToken: '' } as OutgoingGrantAuthority),
    /no usable access token/,
  );
  assert.throws(
    () => rotatedApprovedSpending(previous, { ...authority, manageUrl: '' } as OutgoingGrantAuthority),
    /no management URI/,
  );
});

test('an aborted rotation wait stops the run without any extra debit or consent', async () => {
  // the first rotation sleep is exactly 540_000ms: expiry 600_000 minus the 60_000 margin
  const world = makeCWorld({ abortSleep: 540_000 });
  const evidence = await expectOutcome(runProofC(world.config, world.ports), {
    status: 'INCONCLUSIVE',
    reason: /unexpected error/,
  });
  assert.deepEqual(evidence.lifecycleFailures, [{ category: 'UNEXPECTED_ERROR' }]);
  assert.equal(evidence.interactiveApprovals, 1, 'a second consent was requested after the abort');
  assert.equal(world.authorizeCalls.length, 1);
  assert.equal(evidence.rotationsAttempted, 0, 'a rotation was attempted although its wait was aborted');
  assert.equal(world.rotations.length, 0);
  assert.equal(evidence.executedTransfers, 1, 'an extra debit followed the aborted wait');
  assert.equal(evidence.confirmedTransfers, 1);
  // nothing beyond the settled first payment: no fresh counter reads, no pending state
  assert.deepEqual(evidence.counterReadings.map((r) => r.value), ['0', '0', '10000']);
  assert.deepEqual(evidence.transfers.map((t) => t.state), ['SUCCEEDED']);
});

// ---- explicit configuration ----

test('readProofCConfig accepts exact positive money settings and rejects everything else', () => {
  const env: Record<string, string> = {
    PAYMENT_PROOF_BUDGET_MINOR: '50000',
    PAYMENT_PROOF_C_MAX_DEBIT_MINOR: '15000',
    PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR: '1000',
    PAYMENT_PROOF_C_PAYER_ASSET_CODE: 'USD',
    PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '2',
    PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE: 'EUR',
    PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE: '4',
  };
  const config = readProofCConfig(env);
  assert.deepEqual(config.aggregateBudget, { value: '50000', assetCode: 'USD', assetScale: 2 });
  assert.deepEqual(config.perPaymentMaxDebit, { value: '15000', assetCode: 'USD', assetScale: 2 });
  assert.deepEqual(config.receiveAmount, { value: '1000', assetCode: 'EUR', assetScale: 4 });

  assert.throws(
    () => readProofCConfig({}),
    (error: unknown) => error instanceof Error && /requires explicit money settings with no defaults/.test(error.message),
  );
  for (const name of Object.keys(env)) {
    const probeEnv: Record<string, string> = { ...env };
    delete probeEnv[name];
    assert.throws(() => readProofCConfig(probeEnv), new RegExp(name.replace(/_/g, '_')), `missing ${name} did not complain`);
  }
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_BUDGET_MINOR: '0' }), /must be positive/);
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_C_MAX_DEBIT_MINOR: '5.5' }), /positive integer minor-unit strings/);
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_C_MAX_DEBIT_MINOR: '60000' }), /must not exceed the aggregate grant budget/);
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '256' }), /between 0 and 255/);
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '2.5' }), /between 0 and 255/);
  // a whitespace-only value is rejected by the missing-secrets guard, so the
  // requiredAsset empty-code branch is unreachable from readProofCConfig
  assert.throws(() => readProofCConfig({ ...env, PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE: ' ' }), /no defaults/);
});

test('sanitizedProviderCode keeps only protocol-enum codes', () => {
  for (const code of PROTOCOL_ERROR_CODES) {
    assert.equal(sanitizedProviderCode(code), code);
  }
  assert.equal(sanitizedProviderCode('totally-free-form-text'), undefined);
  assert.equal(sanitizedProviderCode('INVALID_ROTATION'), undefined, 'the whitelist is exact, not normalized');
  assert.equal(sanitizedProviderCode(undefined), undefined);
});

// ---- cleanup downgrades ----

type CleanupEvidence = Parameters<typeof applyCleanupOutcome>[0];

test('cleanup outcomes downgrade a PASSED run and never upgrade a failed one', () => {
  const passed = { status: 'PASSED', reason: 'ok' } as CleanupEvidence;
  const downgraded = applyCleanupOutcome(passed, { retainedForUnresolved: ['outgoing', 'incoming'], warningCount: 1 });
  assert.equal(downgraded.status, 'INCONCLUSIVE');
  assert.match(downgraded.reason, /Cleanup did not complete cleanly/);
  assert.deepEqual(downgraded.cleanupRetainedAuthorities, ['outgoing', 'incoming']);
  assert.equal(downgraded.cleanupWarnings, 1);

  const kept = applyCleanupOutcome(passed, { retainedForUnresolved: [], warningCount: 0 });
  assert.equal(kept.status, 'PASSED');
  assert.deepEqual(kept.cleanupRetainedAuthorities, []);

  const failedBaseline = { status: 'FAILED', reason: 'definitive' } as CleanupEvidence;
  const failed = applyCleanupOutcome(failedBaseline, { retainedForUnresolved: ['outgoing'], warningCount: 2 });
  assert.equal(failed.status, 'FAILED', 'a FAILED run was upgraded');
  assert.deepEqual(failed.cleanupRetainedAuthorities, ['outgoing']);

  const thrown = cleanupFailedEvidence(passed);
  assert.equal(thrown.status, 'INCONCLUSIVE');
  assert.match(thrown.reason, /Cleanup did not complete/);
  const stuck = cleanupFailedEvidence(failedBaseline);
  assert.equal(stuck.status, 'FAILED', 'cleanup throw upgraded a FAILED run');
});

// ---- dry CLI: default NOT_RUN only, in a sanitized secret-free child environment ----

test('the dry CLI prints NOT_RUN with no live activity and never loads real secrets', () => {
  const tsxCli = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = resolve(process.cwd(), 'src', 'commands', 'payment-proof-c.ts');
  const workdir = mkdtempSync(join(tmpdir(), 'proofc-dry-')); // no .env here: dotenv loads nothing real
  try {
    const stdout = execFileSync('node', [tsxCli, script, 'dry'], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
        PAYMENT_PROOF_BUDGET_MINOR: '50000',
        PAYMENT_PROOF_C_MAX_DEBIT_MINOR: '15000',
        PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR: '1000',
        PAYMENT_PROOF_C_PAYER_ASSET_CODE: 'USD',
        PAYMENT_PROOF_C_PAYER_ASSET_SCALE: '2',
        PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE: 'USD',
        PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE: '2',
      },
    });
    const printed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(printed.event, 'payment-proof-c');
    assert.equal(printed.status, 'NOT_RUN');
    assert.equal(printed.mode, 'dry');
    assert.equal(printed.live, false);
    assert.equal(printed.intendedTransfers, 3);
    assert.deepEqual(printed.money, {
      aggregateBudget: { ...BUDGET },
      perPaymentMaxDebit: { ...CEILING },
      receiveAmount: { ...RECEIVE },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('a CLI argument that is neither dry nor --live is refused with constant usage text and exit code 1', () => {
  const tsxCli = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = resolve(process.cwd(), 'src', 'commands', 'payment-proof-c.ts');
  const workdir = mkdtempSync(join(tmpdir(), 'proofc-arg-'));
  try {
    assert.throws(
      () => execFileSync('node', [tsxCli, script, 'zombie-mode'], {
        cwd: workdir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
        },
      }),
      (error: unknown) => {
        const exit = error as { status?: number; stdout?: Buffer; stderr?: string };
        assert.equal(exit.status, 1, 'an unknown argument did not exit nonzero');
        const stderr = String(exit.stderr ?? '');
        const printed = JSON.parse(stderr.trim()) as Record<string, unknown>;
        assert.equal(printed.event, 'payment-proof-c-error', 'the outermost sink changed its event name');
        assert.equal(
          printed.message,
          "Run 'npm run payment:proof-c' for the dry NOT_RUN status, or 'npm run payment:proof-c -- --live' for the owner-approved live run.",
        );
        assert.ok(!stderr.includes('zombie-mode'), 'the refusal echoed free-form provider or arg text');
        return true;
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
