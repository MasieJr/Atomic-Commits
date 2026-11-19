import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  OpenPaymentsClientError,
  type AuthenticatedClient,
  type GrantWithAccessToken,
  type IncomingPayment,
  type OutgoingPayment,
  type Quote,
  type WalletAddress,
} from '@interledger/open-payments';

import { PaymentProofs } from '../src/services/payment-proof';
import {
  ProofStepError,
  type Amount,
  type PaymentEvidence,
  type ProofConfig,
} from '../src/services/payment-proof-run';

// Development-only Test Wallet-shaped endpoints and fixtures. Two seams keep
// these tests provider-free: the injected run.step returns the interactive
// outgoing-grant fixture without executing the live interactive helper, and an
// SDK-shaped fake AuthenticatedClient backs every resource, quote, submission
// and reconciliation call. No network, no callback server, no file reports.
const AUTH = 'https://auth.interledger-test.dev';
const RS = 'https://rs.interledger-test.dev';
const PAYER_ID = 'https://wallet.interledger-test.dev/payer';
const RECEIVER_ID = 'https://wallet.interledger-test.dev/receiver';
const INCOMING_ID = `${RS}/incoming-1`;
const QUOTE_ID = `${RS}/quote-1`;
const OUTGOING_ID = `${RS}/outgoing-1`;

const TOKEN_OUT = 'AT-OUTGOING-GRANT-TOKEN';
const CONT_TOKEN_OUT = 'CONT-OUTGOING-GRANT-TOKEN';
const MANAGE_OUT = `${AUTH}/token/outgoing-grant`;
const CONTINUE_URI_OUT = `${AUTH}/continue/outgoing-grant`;

function wallet(id: string): WalletAddress {
  return { id, assetCode: 'USD', assetScale: 2, authServer: AUTH, resourceServer: RS } as unknown as WalletAddress;
}

const PAYER = wallet(PAYER_ID);
const RECEIVER = wallet(RECEIVER_ID);

function usd(value: string): Amount {
  return { value, assetCode: 'USD', assetScale: 2 };
}

// an SDK-shaped finalized grant the authorization server could return
function finalizedGrant(
  limitKind: 'exact-bound' | 'exact-unbound' | 'narrowed' | 'receiver-only' | 'unexpectedly-bound',
  opts: { expiresIn?: number } = {},
): GrantWithAccessToken {
  const returnedLimits = limitKind === 'exact-bound'
    ? { debitAmount: usd('500'), receiver: RECEIVER_ID }
    : limitKind === 'exact-unbound'
      ? { debitAmount: usd('500') }
      : limitKind === 'narrowed'
        ? { debitAmount: usd('300'), receiver: RECEIVER_ID }
        : limitKind === 'receiver-only'
          ? { receiver: RECEIVER_ID }
          : { debitAmount: usd('500'), receiver: RECEIVER_ID };
  return {
    access_token: {
      value: TOKEN_OUT,
      manage: MANAGE_OUT,
      expires_in: opts.expiresIn ?? 600,
      access: [{ type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER_ID, limits: returnedLimits }],
    },
    continue: { access_token: { value: CONT_TOKEN_OUT }, uri: CONTINUE_URI_OUT },
  } as unknown as GrantWithAccessToken;
}

const boundGrantFixture = finalizedGrant('exact-bound');
const unboundGrantFixture = finalizedGrant('exact-unbound');
const narrowedGrantFixture = finalizedGrant('narrowed');
const receiverOnlyGrantFixture = finalizedGrant('receiver-only');
const unexpectedlyBoundGrantFixture = finalizedGrant('unexpectedly-bound');
const distantExpiryGrantFixture = finalizedGrant('exact-bound', { expiresIn: 9e12 });

// the fake ProofRun records step/secret/save calls; the outgoing-grant step is
// a fixture seam so requestInteractiveGrant (real server + callback) never runs
interface RunState {
  report: {
    version: number;
    runId: string;
    mode: string;
    startedAt: string;
    status: string;
    currentStep: string;
    payments: PaymentEvidence[];
    results: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  rememberedSecrets: string[];
  saves: number;
  steps: string[];
  grantRequests: number;
  safeErrors: Record<string, unknown>[];
}

interface RunLike {
  controller: { signal: AbortSignal };
  report: {
    version: number;
    runId: string;
    mode: string;
    startedAt: string;
    status: string;
    currentStep: string;
    payments: PaymentEvidence[];
    results: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  rememberSecret(value: string): void;
  save(): Promise<void>;
  safeError(error: unknown): Record<string, unknown>;
  step<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

function fakeRun(stepFixtures: Map<string, unknown>): { run: RunLike; state: RunState } {
  const state: RunState = { report: undefined as never, rememberedSecrets: [], saves: 0, steps: [], grantRequests: 0, safeErrors: [] };
  const run: RunLike = {
    controller: { signal: new AbortController().signal },
    report: {
      version: 1,
      runId: 'proof-test-run',
      mode: 'a',
      startedAt: new Date(0).toISOString(),
      status: 'RUNNING',
      currentStep: 'initialization',
      payments: [],
      results: {},
    },
    rememberSecret: (value: string) => {
      if (value) state.rememberedSecrets.push(value);
    },
    save: async () => {
      state.saves += 1;
    },
    safeError: (error: unknown) => {
      const original = error instanceof ProofStepError ? error.original : error;
      let message = original instanceof Error ? original.message : 'Unexpected proof error.';
      for (const secret of state.rememberedSecrets) message = message.split(secret).join('[redacted]');
      const safe: Record<string, unknown> = { step: run.report.currentStep, message: message.slice(0, 1200) };
      state.safeErrors.push(safe);
      return safe;
    },
    step: async <T,>(name: string, operation: () => Promise<T>): Promise<T> => {
      state.steps.push(name);
      if (stepFixtures.has(name)) {
        state.grantRequests += 1;
        const fixture = stepFixtures.get(name);
        if (fixture instanceof Error) throw fixture;
        return fixture as T;
      }
      return operation();
    },
  };
  state.report = run.report; // alias the same evidence object tests read
  return { run, state };
}

// SDK-shaped fake AuthenticatedClient; handlers are mutable between phases
interface ClientHandlers {
  grantRequest: (url: string, body: { access_token: { access: { type: string }[] } }) => Promise<unknown>;
  grantCancel: (args: { url: string; accessToken: string }) => Promise<unknown>;
  incomingCreate: () => Promise<unknown>;
  incomingGet: () => Promise<unknown>;
  quoteCreate: () => Promise<unknown>;
  outgoingCreate: () => Promise<unknown>;
  outgoingGet: () => Promise<unknown>;
}

interface ClientCalls {
  grantRequests: unknown[];
  grantCancels: { url: string; accessToken: string }[];
  incomingCreates: number;
  quoteCreates: number;
  outgoingCreates: number;
  outgoingGets: number;
  incomingGets: number;
}

function incomingFixture(overrides: Record<string, unknown> = {}): unknown {
  return { id: INCOMING_ID, walletAddress: RECEIVER_ID, receivedAmount: usd('0'), ...overrides };
}

function quoteFixture(debitValue: string, opts: { expiresAt?: string } = {}): unknown {
  return {
    id: QUOTE_ID,
    walletAddress: PAYER_ID,
    receiver: INCOMING_ID,
    method: 'ilp',
    debitAmount: usd(debitValue),
    receiveAmount: usd('10'),
    expiresAt: opts.expiresAt ?? '2100-01-01T00:00:00.000Z',
  };
}

function outgoingFixture(sentValue: string, failed: boolean, debitValue: string): OutgoingPayment {
  return {
    id: OUTGOING_ID,
    walletAddress: PAYER_ID,
    receiver: INCOMING_ID,
    quoteId: QUOTE_ID,
    debitAmount: usd(debitValue),
    sentAmount: sentValue === '' ? undefined : usd(sentValue),
    failed,
  } as OutgoingPayment;
}

function makeClient(overrides: Partial<ClientHandlers> = {}): {
  client: AuthenticatedClient;
  handlers: ClientHandlers;
  calls: ClientCalls;
  quoteState: { debit: string; expiresAt: string };
} {
  const calls: ClientCalls = {
    grantRequests: [],
    grantCancels: [],
    incomingCreates: 0,
    quoteCreates: 0,
    outgoingCreates: 0,
    outgoingGets: 0,
    incomingGets: 0,
  };
  // the current quote drives submission and reconciliation fixtures so they
  // always describe the same provider attempt as the quote the code saw
  const quoteState = { debit: '500', expiresAt: '2100-01-01T00:00:00.000Z' };
  const handlers: ClientHandlers = {
    grantRequest: async (url, body) => {
      calls.grantRequests.push(url);
      return body.access_token.access[0].type === 'incoming-payment'
        ? {
            access_token: {
              value: 'AT-INCOMING-GRANT-TOKEN',
              manage: `${AUTH}/token/incoming-grant`,
              expires_in: 600,
              access: [{ type: 'incoming-payment', actions: ['create', 'read', 'complete'] }],
            },
            continue: { access_token: { value: 'CONT-INCOMING-GRANT-TOKEN' }, uri: `${AUTH}/continue/incoming-grant` },
          }
        : {
            access_token: {
              value: 'AT-QUOTE-GRANT-TOKEN',
              manage: `${AUTH}/token/quote-grant`,
              expires_in: 600,
              access: [{ type: 'quote', actions: ['create', 'read'] }],
            },
            continue: { access_token: { value: 'CONT-QUOTE-GRANT-TOKEN' }, uri: `${AUTH}/continue/quote-grant` },
          };
    },
    grantCancel: async (args) => {
      calls.grantCancels.push(args);
    },
    incomingCreate: async () => {
      calls.incomingCreates += 1;
      return incomingFixture();
    },
    incomingGet: async () => {
      calls.incomingGets += 1;
      return incomingFixture({ receivedAmount: usd('10'), completed: true });
    },
    quoteCreate: async () => {
      calls.quoteCreates += 1;
      return quoteFixture(quoteState.debit, { expiresAt: quoteState.expiresAt });
    },
    outgoingCreate: async () => {
      calls.outgoingCreates += 1;
      return outgoingFixture(quoteState.debit, false, quoteState.debit);
    },
    outgoingGet: async () => {
      calls.outgoingGets += 1;
      return outgoingFixture(quoteState.debit, false, quoteState.debit);
    },
  };
  Object.assign(handlers, overrides);
  const client = {
    grant: {
      request: (url: string, body: { access_token: { access: { type: string }[] } }) => handlers.grantRequest(url, body),
      cancel: (args: { url: string; accessToken: string }) => handlers.grantCancel(args),
    },
    incomingPayment: {
      create: () => handlers.incomingCreate(),
      get: () => handlers.incomingGet(),
    },
    quote: {
      create: () => handlers.quoteCreate(),
    },
    outgoingPayment: {
      create: () => handlers.outgoingCreate(),
      get: () => handlers.outgoingGet(),
    },
  };
  return { client: client as unknown as AuthenticatedClient, handlers, calls, quoteState };
}

const config: ProofConfig = {
  receiveMinor: '10',
  budgetMinor: '500',
  callbackPort: 3999,
  consentTimeoutMs: 600_000,
  settlementTimeoutMs: 50, // bounds the confirmation loop: one retry sleep, then it reports
};

interface ProofHarness {
  proofs: PaymentProofs;
  state: RunState;
  run: RunLike;
  handlers: ClientHandlers;
  calls: ClientCalls;
  quoteState: { debit: string; expiresAt: string };
}

interface ApprovedSpendingLike {
  grant: GrantWithAccessToken;
  budget: Amount;
  expiresAt?: number;
}

function buildProofs(grantFixture: GrantWithAccessToken): ProofHarness {
  // label used by every authorize call in this file
  const stepFixtures = new Map<string, unknown>([['A-budget: request and continue outgoing grant', grantFixture]]);
  const { run, state } = fakeRun(stepFixtures);
  const { client, handlers, calls, quoteState } = makeClient();
  // the constructor is private; tests use the exact same wiring as ProofMode.create
  const Construct = PaymentProofs as unknown as new (
    run: RunLike,
    config: ProofConfig,
    client: AuthenticatedClient,
    sender: WalletAddress,
    receiver: WalletAddress,
  ) => PaymentProofs;
  const proofs = new Construct(run, config, client, PAYER, RECEIVER);
  return { proofs, state, run, handlers, calls, quoteState };
}

function authorizeWithSeam(grantFixture: GrantWithAccessToken, requested: Amount, receiver?: string): Promise<{ harness: ProofHarness; spending: ApprovedSpendingLike }> {
  const harness = buildProofs(grantFixture);
  const spendingPromise = receiver === undefined
    ? harness.proofs.authorize('A-budget', requested)
    : harness.proofs.authorize('A-budget', requested, receiver);
  return spendingPromise.then((spending) => ({ harness, spending: spending as unknown as ApprovedSpendingLike }));
}

async function rejectsAuthorize(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof Error, 'authorize must reject with an Error');
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(TOKEN_OUT), 'rejection echoed the access token');
      assert.ok(!error.message.includes(CONTINUE_URI_OUT), 'rejection echoed the continuation URI');
      assert.ok(!error.message.includes(MANAGE_OUT), 'rejection echoed the manage URI');
      return true;
    },
    `expected authorize rejection matching ${String(pattern)}`,
  );
}

function jsonReport(harness: ProofHarness): string {
  return JSON.stringify(harness.state.report) + JSON.stringify(harness.state.safeErrors);
}

async function assertNoGrantSecrets(harness: ProofHarness): Promise<void> {
  const json = jsonReport(harness);
  for (const secret of [TOKEN_OUT, CONT_TOKEN_OUT, MANAGE_OUT, CONTINUE_URI_OUT]) {
    assert.ok(!json.includes(secret), 'report carries a raw grant secret');
  }
}

// full prepared + approved setup for pay/confirm/cleanup tests: initialize and
// prepare run through the fake client, the grant is installed through the
// public installOutgoingGrant seam, and quote fixtures always match quoteState
async function proofsReadyToPay(grantFixture: GrantWithAccessToken, quoteDebit = '500', staleQuote = false): Promise<ProofHarness & { spending: ApprovedSpendingLike }> {
  const harness = buildProofs(grantFixture);
  harness.quoteState.debit = quoteDebit;
  if (staleQuote) harness.quoteState.expiresAt = '2000-01-01T00:00:00.000Z';
  await harness.proofs.initializeResourceGrants();
  const spending = await harness.proofs.installOutgoingGrant('A-budget', grantFixture, usd('500'), RECEIVER_ID);
  return { ...harness, spending: spending as unknown as ApprovedSpendingLike };
}

test('payment proofs authorize a receiver-bound grant with its exact returned cap', async () => {
  const { harness, spending } = await authorizeWithSeam(boundGrantFixture, usd('500'), RECEIVER_ID);
  assert.deepEqual(spending.budget, { value: '500', assetCode: 'USD', assetScale: 2 });
  assert.ok(spending.expiresAt !== undefined && spending.expiresAt > Date.now(), 'deadline was not derived from expires_in');
  assert.deepEqual(harness.state.report.results['A-budgetGrant'], {
    referenceDigest: createHash('sha256').update(CONTINUE_URI_OUT).digest('hex').slice(0, 16),
    interactiveApprovals: 1,
    requestedBudget: usd('500'),
    returnedLimits: { debitAmount: usd('500'), receiver: RECEIVER_ID },
    expiresInSeconds: 600,
  });
  assert.equal(harness.state.grantRequests, 1, 'the grant request ran exactly once through the step seam');
  await assertNoGrantSecrets(harness);
});

test('payment proofs authorize an unbound grant and keep the returned limits receiver-free', async () => {
  const { harness, spending } = await authorizeWithSeam(unboundGrantFixture, usd('500'));
  assert.deepEqual(spending.budget, { value: '500', assetCode: 'USD', assetScale: 2 });
  const evidence = harness.state.report.results['A-budgetGrant'];
  assert.ok(evidence !== undefined);
  assert.ok(!('receiver' in (evidence as { returnedLimits: Record<string, unknown> }).returnedLimits), 'unbound grant exposes a receiver');
  assert.equal(harness.state.grantRequests, 1);
});

test('payment proofs keep the provider-narrowed cap and show it as the trusted budget', async () => {
  const { harness, spending } = await authorizeWithSeam(narrowedGrantFixture, usd('500'), RECEIVER_ID);
  assert.deepEqual(spending.budget, { value: '300', assetCode: 'USD', assetScale: 2 });
  const evidence = harness.state.report.results['A-budgetGrant'] as { returnedLimits: { debitAmount: Amount } };
  assert.deepEqual(evidence.returnedLimits.debitAmount, usd('300'));
  assert.equal(harness.state.grantRequests, 1);
});

test('payment proofs reject an unexpected receiver binding without writing evidence', async () => {
  const harness = buildProofs(unexpectedlyBoundGrantFixture);
  await rejectsAuthorize(
    harness.proofs.authorize('A-budget', usd('500')),
    /bound the unrestricted grant to a receiver that was not requested/,
  );
  assert.equal(harness.state.report.results['A-budgetGrant'], undefined);
  // secrets were registered before validation so cleanup can still revoke the grant
  assert.deepEqual(harness.state.rememberedSecrets, [CONT_TOKEN_OUT, TOKEN_OUT, MANAGE_OUT, CONTINUE_URI_OUT]);
});

test('payment proofs reject a receiver-only response for lacking the debit cap', async () => {
  const harness = buildProofs(receiverOnlyGrantFixture);
  await rejectsAuthorize(harness.proofs.authorize('A-budget', usd('500'), RECEIVER_ID), /no debit cap for the outgoing grant/);
  assert.equal(harness.state.report.results['A-budgetGrant'], undefined);
});

test('payment proofs reject request budgets that exceed the configured cap before any provider call', async () => {
  const overBudget = buildProofs(boundGrantFixture);
  await rejectsAuthorize(overBudget.proofs.authorize('A-budget', usd('600')), /exceeds the configured proof budget/);
  assert.equal(overBudget.state.grantRequests, 0, 'no grant request ran for an over-budget ask');
  assert.equal(overBudget.state.rememberedSecrets.length, 0);

  const wrongAsset = buildProofs(boundGrantFixture);
  await rejectsAuthorize(
    wrongAsset.proofs.authorize('A-budget', { value: '500', assetCode: 'EUR', assetScale: 2 }),
    /exceeds the configured proof budget, is not positive, or uses a different asset/,
  );
  assert.equal(wrongAsset.state.grantRequests, 0);
});

test('payment proofs reject deadline arithmetic the wrapper cannot represent reliably', async () => {
  const harness = buildProofs(distantExpiryGrantFixture);
  await rejectsAuthorize(
    harness.proofs.authorize('A-budget', usd('500'), RECEIVER_ID),
    /too distant to represent a reliable payment deadline/,
  );
  assert.equal(harness.state.report.results['A-budgetGrant'], undefined, 'no evidence survives an unusable deadline');
  assert.deepEqual(harness.state.rememberedSecrets, [CONT_TOKEN_OUT, TOKEN_OUT, MANAGE_OUT, CONTINUE_URI_OUT]);
});

test('payment proof evidence carries only the digest of the continuation URI and never its value', async () => {
  const { harness } = await authorizeWithSeam(boundGrantFixture, usd('500'), RECEIVER_ID);
  const digest = (harness.state.report.results['A-budgetGrant'] as { referenceDigest?: string }).referenceDigest;
  assert.ok(digest !== undefined);
  assert.match(digest, /^[0-9a-f]{16}$/);
  assert.equal(digest, createHash('sha256').update(CONTINUE_URI_OUT).digest('hex').slice(0, 16));
  const json = jsonReport(harness);
  assert.ok(!json.includes(CONTINUE_URI_OUT), 'raw continuation URI leaked');
  assert.ok(!json.includes(MANAGE_OUT), 'raw manage URI leaked');
  assert.ok(!json.includes(TOKEN_OUT), 'raw token leaked');
});

// ---- submission state machine ----

test('a prepared payment is debited once and confirmed by both provider readings', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  const prepared = await h.proofs.prepare('A-budget');
  const evidence = await h.proofs.pay(prepared, h.spending, usd('500'));
  assert.equal(evidence.state, 'SUCCEEDED');
  assert.equal(evidence.outgoingPaymentId, OUTGOING_ID);
  assert.deepEqual(evidence.sentAmount, usd('500'));
  assert.deepEqual(evidence.receivedAmount, usd('10'));
  assert.equal(h.calls.outgoingCreates, 1, 'the debit ran exactly once');
  assert.ok(h.calls.outgoingGets >= 1, 'the outgoing payment was reconciled');
  assert.ok(h.calls.incomingGets >= 1, 'the incoming payment was reconciled');
});

test('repeated or concurrent pay calls never trigger a second debit', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  const prepared = await h.proofs.prepare('A-budget');
  const first = h.proofs.pay(prepared, h.spending, usd('500')).then(() => 'paid').catch((error: unknown) => `failed: ${String(error)}`);
  const second = h.proofs.pay(prepared, h.spending, usd('500')).then(() => 'paid').catch((error: unknown) => `failed: ${String(error)}`);
  const outcomes = await Promise.all([first, second]);
  assert.match(outcomes[0], /^paid|failed.*already submitted/);
  assert.match(outcomes[1], /already submitted/);
  assert.equal(h.calls.outgoingCreates, 1, 'a second debit was attempted');
  assert.match(outcomes[0], /^paid$/);
});

test('definitive 4xx rejections mark the evidence FAILED while unclear outcomes stay UNKNOWN', async () => {
  const rejected = buildProofs(boundGrantFixture);
  await rejected.proofs.initializeResourceGrants();
  const spendingRejected = await rejected.proofs.installOutgoingGrant('A-budget', boundGrantFixture, usd('500'), RECEIVER_ID);
  const preparedRejected = await rejected.proofs.prepare('A-budget');
  rejected.handlers.outgoingCreate = async () => {
    rejected.calls.outgoingCreates += 1;
    throw new OpenPaymentsClientError('request failed', { description: 'grant check failed', status: 403, code: 'insufficient_grant' });
  };
  await assert.rejects(rejected.proofs.pay(preparedRejected, spendingRejected as never, usd('500')));
  assert.equal(preparedRejected.evidence.state, 'FAILED', `evidence was ${preparedRejected.evidence.state}`);

  const obscure = buildProofs(boundGrantFixture);
  await obscure.proofs.initializeResourceGrants();
  const spendingObscure = await obscure.proofs.installOutgoingGrant('A-budget', boundGrantFixture, usd('500'), RECEIVER_ID);
  const preparedObscure = await obscure.proofs.prepare('A-budget');
  obscure.handlers.outgoingCreate = async () => {
    obscure.calls.outgoingCreates += 1;
    throw new OpenPaymentsClientError('request failed', { description: 'gateway trouble', status: 500 });
  };
  await assert.rejects(obscure.proofs.pay(preparedObscure, spendingObscure as never, usd('500')));
  assert.equal(preparedObscure.evidence.state, 'UNKNOWN', `evidence was ${preparedObscure.evidence.state}`);
  // an UNKNOWN outcome is never retried: another pay call is refused, no second debit
  await assert.rejects(obscure.proofs.pay(preparedObscure, spendingObscure as never, usd('500')), /already submitted/);
  assert.equal(obscure.calls.outgoingCreates, 1);
});

test('a stale quote is refreshed before submission and the fresh debit re-checks remaining budget and ceiling', async () => {
  // approved cap 500, remaining 500; a stale 400 quote is refreshed to 450:
  // a 400 ceiling refuses the fresh 450 debit, a 450 ceiling accepts it
  const h = await proofsReadyToPay(boundGrantFixture, '400', true);
  let quoteCalls = 0;
  h.handlers.quoteCreate = async () => {
    h.calls.quoteCreates += 1;
    quoteCalls += 1;
    if (quoteCalls === 1) return quoteFixture('400', { expiresAt: '2000-01-01T00:00:00.000Z' }); // prepare keeps the stale quote it recorded
    h.quoteState.debit = '450'; // reconciliation fixtures follow the fresh quote
    h.quoteState.expiresAt = '2100-01-01T00:00:00.000Z';
    return quoteFixture('450');
  };
  const prepared = await h.proofs.prepare('A-budget');
  assert.deepEqual(prepared.evidence.quotedDebit, usd('400'), 'prepare saw the stale quote');
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, usd('500'), usd('400')),
    /exceeds the explicit per-payment ceiling/,
  );
  assert.deepEqual(prepared.evidence.quotedDebit, usd('450'), 'the refactor missed recording the refreshed quote');
  assert.equal(h.calls.quoteCreates, 2, 'the stale quote was refreshed exactly once');
  assert.equal(h.calls.outgoingCreates, 0, 'no debit ran for a ceiling-violating refresh');
  assert.equal(prepared.evidence.state, 'PREPARED');
  // the refreshed quote is still debitable on its own merits once the ceiling allows it
  const evidence = await h.proofs.pay(prepared, h.spending, usd('500'), usd('450'));
  assert.equal(evidence.state, 'SUCCEEDED');
  assert.equal(h.calls.outgoingCreates, 1);
  assert.equal(h.calls.quoteCreates, 2, 'the fresh quote was never re-quoted before submission');
});

// the caller-supplied remaining budget is never trusted wider than the approved cap:
// forging it cannot widen any later check and is rejected with no provider interaction
test('a forged remaining budget is refused before any provider call affects the payment', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  const prepared = await h.proofs.prepare('A-budget');
  const quoteCallsAfterPrepare = h.calls.quoteCreates;

  // wider than the approved cap: can never be reached through real provider behavior
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, usd('650'), usd('600')),
    /not at or below the approved spending budget/,
  );
  // wrong asset than the approved budget
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, { value: '500', assetCode: 'EUR', assetScale: 2 }, usd('600')),
    /not at or below the approved spending budget/,
  );
  // negative and non-canonical amounts are not representable budgets
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, { value: '-5', assetCode: 'USD', assetScale: 2 }, usd('600')),
    /not a canonical nonnegative integer amount/,
  );
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, { value: '01', assetCode: 'USD', assetScale: 2 }, usd('600')),
    /not a canonical nonnegative integer amount/,
  );

  assert.equal(prepared.evidence.state, 'PREPARED', 'a forged remaining budget changed the payment state');
  assert.equal(h.calls.outgoingCreates, 0, 'a debit ran for a forged remaining budget');
  assert.equal(h.calls.quoteCreates, quoteCallsAfterPrepare, 'the payment was re-quoted across a forged remaining budget');
  assert.equal(h.calls.outgoingGets, 0);
  assert.equal(h.calls.incomingGets, 0);
});

test('installOutgoingGrant enforces the same configured cap as authorize and keeps the issued grant for cleanup', async () => {
  const invalidRequests: [string, Amount][] = [
    ['over the configured cap', usd('600')],
    ['not positive', usd('0')],
    ['wrong asset', { value: '500', assetCode: 'EUR', assetScale: 2 }],
  ];
  for (const [name, requested] of invalidRequests) {
    const h = buildProofs(boundGrantFixture);
    await rejectsAuthorize(
      h.proofs.installOutgoingGrant('A-budget', boundGrantFixture, requested, RECEIVER_ID),
      /exceeds the configured proof budget, is not positive, or uses a different asset/,
    );
    assert.equal(h.state.report.results['A-budgetGrant'], undefined, `${name}: evidence survived a rejected install`);
    // the grant was already issued and registered for redaction/revocation BEFORE
    // validation, so a rejected install is never an orphan — cleanup can still cancel it
    assert.deepEqual(h.state.rememberedSecrets, [CONT_TOKEN_OUT, TOKEN_OUT, MANAGE_OUT, CONTINUE_URI_OUT]);
    await h.proofs.cleanup();
    assert.deepEqual(
      h.calls.grantCancels,
      [{ url: CONTINUE_URI_OUT, accessToken: CONT_TOKEN_OUT }],
      `${name}: the already-issued grant was not tracked for cleanup`,
    );
  }
});

test('an aborted run is refused before its debit and never reaches the provider', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  const prepared = await h.proofs.prepare('A-budget');
  h.run.controller.signal = AbortSignal.abort();
  await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')));
  assert.equal(h.calls.outgoingCreates, 0);
});

// ---- confirmation loop ----

test('provider confirmation rejects payments the provider marked failed and keeps the state FAILED', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.handlers.outgoingGet = async () => {
    h.calls.outgoingGets += 1;
    return outgoingFixture('200', true, '500');
  };
  const prepared = await h.proofs.prepare('A-budget');
  await assert.rejects(
    h.proofs.pay(prepared, h.spending, usd('500')),
    (error: unknown) => {
      assert.ok(error instanceof ProofStepError);
      assert.match((error.original as Error).message, /marked the outgoing payment failed/);
      return true;
    },
  );
  assert.equal(prepared.evidence.state, 'FAILED');
});

test('provider confirmation rejects references that do not match this attempt', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.handlers.outgoingGet = async () => ({
    ...outgoingFixture('500', false, '500'),
    receiver: `${RS}/incoming-someone-else`,
  });
  const prepared = await h.proofs.prepare('A-budget');
  await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')), /still pending or unknown/);
  assert.equal(prepared.evidence.state, 'UNKNOWN');
  await assertNoGrantSecrets(h);
});

test('provider confirmation requires an explicitly complete settlement before declaring success', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.handlers.incomingGet = async () => {
    h.calls.incomingGets += 1;
    return incomingFixture({ receivedAmount: usd('10'), completed: false });
  };
  const prepared = await h.proofs.prepare('A-budget');
  await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')), /still pending or unknown/);
  assert.equal(prepared.evidence.state, 'UNKNOWN');
});

test('provider confirmation treats a partial or absent sent amount as unsettled', async () => {
  for (const sent of ['', '100']) {
    const h = await proofsReadyToPay(boundGrantFixture);
    h.handlers.outgoingGet = async () => outgoingFixture(sent, false, '500');
    const prepared = await h.proofs.prepare('A-budget');
    await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')), /still pending or unknown/);
    assert.equal(prepared.evidence.state, 'UNKNOWN', `partial send "${sent}" was treated as settled`);
  }
});

test('provider confirmation treats a full sent amount in a different asset or scale as unsettled', async () => {
  for (const sent of [
    { value: '500', assetCode: 'EUR', assetScale: 2 }, // different asset, same quoted amount
    { value: '500', assetCode: 'USD', assetScale: 3 }, // different scale, same nominal digits
  ]) {
    const h = await proofsReadyToPay(boundGrantFixture);
    h.handlers.outgoingGet = async () => {
      h.calls.outgoingGets += 1;
      return { ...outgoingFixture('500', false, '500'), sentAmount: sent };
    };
    const prepared = await h.proofs.prepare('A-budget');
    await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')), /still pending or unknown/);
    assert.equal(prepared.evidence.state, 'UNKNOWN', `sent amount ${JSON.stringify(sent)} was treated as settled`);
  }
});

test('provider confirmation requires an explicit non-failed payment before declaring success', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.handlers.outgoingGet = async () => {
    h.calls.outgoingGets += 1;
    const { failed, ...rest } = outgoingFixture('500', false, '500') as { failed?: unknown } & Record<string, unknown>;
    return rest; // `failed` absent, exactly as a provider that never set it would answer
  };
  const prepared = await h.proofs.prepare('A-budget');
  await assert.rejects(h.proofs.pay(prepared, h.spending, usd('500')), /still pending or unknown/);
  assert.equal(prepared.evidence.state, 'UNKNOWN', 'a payment without an explicit failed=false was treated as approved');
});

// ---- cleanup ----

test('cleanup retains outgoing and incoming grant authority while any payment is unresolved', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  await h.proofs.prepare('A-budget');
  h.state.report.payments.push({ label: 'pending', state: 'SUBMITTING', incomingPaymentId: INCOMING_ID, quoteId: QUOTE_ID, quotedDebit: usd('500'), quotedReceive: usd('10') });
  await h.proofs.cleanup();
  assert.deepEqual(h.calls.grantCancels, [{ url: `${AUTH}/continue/quote-grant`, accessToken: 'CONT-QUOTE-GRANT-TOKEN' }]);
  assert.deepEqual(h.state.report.results.grantCleanup, {
    authoritiesRetainedForUnresolvedPayments: ['outgoing', 'incoming'],
    warnings: [],
  });
});

test('cleanup cancels every retained grant authority once all payments are resolved', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.state.report.payments.push({ label: 'done', state: 'SUCCEEDED', incomingPaymentId: INCOMING_ID, quoteId: QUOTE_ID, quotedDebit: usd('500'), quotedReceive: usd('10') });
  await h.proofs.cleanup();
  assert.deepEqual(
    h.calls.grantCancels.map((cancel) => cancel.url),
    [CONTINUE_URI_OUT, `${AUTH}/continue/quote-grant`, `${AUTH}/continue/incoming-grant`],
    `cancels ran as: ${JSON.stringify(h.calls.grantCancels)}`,
  );
  assert.deepEqual(h.state.report.results.grantCleanup, {
    authoritiesRetainedForUnresolvedPayments: [],
    warnings: [],
  });
  await assertNoGrantSecrets(h);
});

test('cleanup warnings report cancelled secrets only in redacted form', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.handlers.grantCancel = async (args: { url: string; accessToken: string }) => {
    h.calls.grantCancels.push(args);
    throw new Error(`cancel failed: ${args.accessToken} via ${args.url}`);
  };
  h.state.report.payments.push({ label: 'done', state: 'SUCCEEDED', incomingPaymentId: INCOMING_ID, quoteId: QUOTE_ID, quotedDebit: usd('500'), quotedReceive: usd('10') });
  await h.proofs.cleanup();
  const warnings = (h.state.report.results.grantCleanup as { warnings: { message: string }[] }).warnings;
  assert.equal(warnings.length, 3);
  for (const warning of warnings) {
    assert.ok(warning.message.includes('[redacted]'), 'warning was not redacted');
    assert.ok(!warning.message.includes('AT-'), 'warning still carries a token');
    assert.ok(!warning.message.includes('CONT-'), 'warning still carries a continuation token');
    assert.ok(!warning.message.includes(AUTH), 'warning still carries a URI');
  }
  await assertNoGrantSecrets(h);
});

test('cleanup still runs after an abort so resolved grants are never left alive', async () => {
  const h = await proofsReadyToPay(boundGrantFixture);
  h.state.report.payments.push({ label: 'done', state: 'FAILED', incomingPaymentId: INCOMING_ID, quoteId: QUOTE_ID, quotedDebit: usd('500'), quotedReceive: usd('10') });
  h.run.controller.signal = AbortSignal.abort('finished');
  await h.proofs.cleanup();
  assert.equal(h.calls.grantCancels.length, 3);
  await assertNoGrantSecrets(h);
});

test('resource grants are reused only while both advertised lifetimes remain safe', async () => {
  const h = buildProofs(unboundGrantFixture);
  await h.proofs.ensureResourceGrants();
  await h.proofs.ensureResourceGrants();
  assert.equal(h.calls.grantRequests.length, 2);
});

test('resource grants with unknown expiry are not assumed reusable', async () => {
  const h = buildProofs(unboundGrantFixture);
  const original = h.handlers.grantRequest;
  h.handlers.grantRequest = async (url, body) => {
    const grant = await original(url, body) as { access_token: { expires_in?: number } };
    delete grant.access_token.expires_in;
    return grant;
  };
  await h.proofs.ensureResourceGrants();
  await h.proofs.ensureResourceGrants();
  assert.equal(h.calls.grantRequests.length, 4);
});

test('resource grants with insufficient expiry margin are not reused', async () => {
  const h = buildProofs(unboundGrantFixture);
  const original = h.handlers.grantRequest;
  h.handlers.grantRequest = async (url, body) => {
    const grant = await original(url, body) as { access_token: { expires_in?: number } };
    grant.access_token.expires_in = 5;
    return grant;
  };
  await h.proofs.ensureResourceGrants();
  await h.proofs.ensureResourceGrants();
  assert.equal(h.calls.grantRequests.length, 4);
});
