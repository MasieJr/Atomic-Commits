import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OpenPaymentsClientError, type AccessToken, type OutgoingPaymentGrantSpentAmounts } from '@interledger/open-payments';

import {
  GrantLifecycleError,
  OutgoingGrantLifecycle,
  type GrantLifecycleErrorCategory,
  type GrantLifecyclePorts,
  type OutgoingGrantAuthority,
} from '../src/services/grant-lifecycle';

// Development-only Test Wallet-shaped identifiers. The whole lifecycle runs on
// injectable fake ports (rotateToken / readSpentAmounts / clock / rememberSecret),
// so no provider, server or clock is touched while exercising rotation, counter
// verification and the fail-closed phases.
const AUTH = 'https://auth.interledger-test.dev';
const RS = 'https://rs.interledger-test.dev';
const PAYER_ID = 'https://wallet.interledger-test.dev/payer';
const RECEIVER_ID = 'https://wallet.interledger-test.dev/receiver';
const OLD_TOKEN = 'AT-LIFECYCLE-OLD-TOKEN';
const NEW_TOKEN = 'AT-LIFECYCLE-NEW-TOKEN';
const OLD_MANAGE = `${AUTH}/token/old`;
const NEW_MANAGE = `${AUTH}/token/new`;
const BASE = 1_700_000_000_000;

function usd(value: string): { value: string; assetCode: string; assetScale: number } {
  return { value, assetCode: 'USD', assetScale: 2 };
}

function authority(overrides: Partial<OutgoingGrantAuthority> = {}): OutgoingGrantAuthority {
  return {
    accessToken: OLD_TOKEN,
    manageUrl: OLD_MANAGE,
    expiresAt: BASE + 600_000,
    payerId: PAYER_ID,
    resourceServerUrl: RS,
    budget: usd('500'),
    ...overrides,
  };
}

// an SDK-shaped rotation response the authorization server could return
interface RotationOptions {
  value?: string;
  omitValue?: boolean;
  manage?: string | null;
  expiresIn?: number | null;
  receiver?: string;
  debit?: string;
  actions?: string[];
  interval?: string;
}

function rotationToken(opts: RotationOptions = {}): Record<string, unknown> {
  const token: Record<string, unknown> = {
    ...(opts.omitValue ? {} : { value: opts.value ?? NEW_TOKEN }),
    ...(opts.manage === null ? {} : { manage: opts.manage ?? NEW_MANAGE }),
    ...(opts.expiresIn === null ? {} : { expires_in: opts.expiresIn ?? 600 }),
    access: [{
      type: 'outgoing-payment',
      actions: opts.actions ?? ['create', 'read'],
      identifier: PAYER_ID,
      limits: {
        debitAmount: usd(opts.debit ?? '500'),
        ...(opts.receiver === undefined ? {} : { receiver: opts.receiver }),
        ...(opts.interval === undefined ? {} : { interval: opts.interval }),
      },
    }],
  };
  return { access_token: token }; // the full AccessToken response shape
}

interface DeferredRotation {
  promise: Promise<Record<string, unknown>>;
  settle(value: Record<string, unknown> | Error): void;
}

function deferredRotation(): DeferredRotation {
  let settleRef!: (value: Record<string, unknown> | Error) => void;
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    settleRef = (value) => (value instanceof Error ? reject(value) : resolve(value));
  });
  return { promise, settle: settleRef };
}

interface LifecycleHarness {
  lifecycle: OutgoingGrantLifecycle;
  clock: { value: number };
  rotations: { url: string; accessToken: string }[];
  spentReads: { url: string; accessToken: string }[];
  remembered: string[];
  spentValues: unknown[];
  rotationTokens: Record<string, unknown>[];
  rotationFailures: Error[];
  rotationDeferred?: DeferredRotation;
  advanceOnRotate: number;
}

function makeLifecycle(opts: { spentValues?: unknown[]; rotationTokens?: Record<string, unknown>[]; rotationFailures?: Error[]; advanceOnRotate?: number } = {}): LifecycleHarness {
  const clock = { value: BASE };
  const harness: LifecycleHarness = {
    clock,
    rotations: [],
    spentReads: [],
    remembered: [],
    spentValues: opts.spentValues ?? [{ spentDebitAmount: usd('0') }],
    rotationTokens: opts.rotationTokens ?? [rotationToken()],
    rotationFailures: opts.rotationFailures ?? [],
    rotationDeferred: undefined,
    advanceOnRotate: opts.advanceOnRotate ?? 0,
    lifecycle: undefined as never,
  };
  const ports: GrantLifecyclePorts = {
    rotateToken: async (args) => {
      harness.rotations.push(args);
      clock.value += harness.advanceOnRotate; // simulated network delay may exhaust the window
      if (harness.rotationFailures.length > 0) throw harness.rotationFailures.shift() as Error;
      if (harness.rotationDeferred) return (await harness.rotationDeferred.promise) as unknown as AccessToken;
      const next = harness.rotationTokens.length > 1 ? harness.rotationTokens.shift() : harness.rotationTokens[0];
      return next as unknown as AccessToken;
    },
    readSpentAmounts: async (args) => {
      harness.spentReads.push(args);
      const next = harness.spentValues.length > 1 ? harness.spentValues.shift() : harness.spentValues[0];
      if (next instanceof Error) throw next;
      return next as OutgoingPaymentGrantSpentAmounts;
    },
    clock: () => clock.value,
    rememberSecret: (value: string) => {
      if (value) harness.remembered.push(value);
    },
  };
  harness.lifecycle = new OutgoingGrantLifecycle(ports);
  return harness;
}

interface LifecycleExpect {
  category?: GrantLifecycleErrorCategory;
  message?: RegExp;
}

function lifecycleError(error: unknown, opts: LifecycleExpect): boolean {
  assert.ok(error instanceof Error, `expected an Error but rejected with ${String(error)}`);
  assert.ok(error instanceof GrantLifecycleError, `expected a GrantLifecycleError, got: ${String(error)}`);
  if (opts.category !== undefined) assert.equal((error as GrantLifecycleError).category, opts.category);
  if (opts.message) assert.match((error as Error).message, opts.message);
  const text = (error as Error).message;
  assert.ok(!/AT-LIFECYCLE|interledger-test|500/.test(text), 'lifecycle failure leaked grant data into the message');
  return true;
}

function rejectsLifecycle(promise: Promise<unknown>, opts: LifecycleExpect): Promise<void> {
  return assert.rejects(promise, (error: unknown) => lifecycleError(error, opts));
}

test('lifecycle refuses a non-object authority without poisoning', async () => {
  const h = makeLifecycle();
  await rejectsLifecycle(
    h.lifecycle.rotate(undefined as unknown as OutgoingGrantAuthority),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /No current outgoing authority was supplied/ },
  );
  assert.equal(h.lifecycle.phase, 'READY');
  assert.equal(h.rotations.length, 0);
});

test('lifecycle refuses an authority without a usable access token and does not poison', async () => {
  const h = makeLifecycle();
  await rejectsLifecycle(
    h.lifecycle.rotate(authority({ accessToken: '' })),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /access token is absent/ },
  );
  assert.equal(h.lifecycle.phase, 'READY');
});

test('lifecycle refuses an authority without a management URI and does not poison', async () => {
  const h = makeLifecycle();
  await rejectsLifecycle(
    h.lifecycle.rotate(authority({ manageUrl: '' })),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /did not give this token a management URI/ },
  );
  assert.equal(h.lifecycle.phase, 'READY');
});

test('lifecycle refuses management URIs outside the supported Test Wallet endpoints', async () => {
  const h = makeLifecycle();
  await rejectsLifecycle(
    h.lifecycle.rotate(authority({ manageUrl: 'https://auth.example.com/token/old' })),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /outside the supported Test Wallet endpoints/ },
  );
  assert.equal(h.lifecycle.phase, 'READY');
});

test('lifecycle refuses a grant cap that is not a positive exact amount', async () => {
  for (const budget of [{ ...usd('500'), value: '5.5' }, { ...usd('500'), value: '0' }]) {
    const harness = makeLifecycle();
    await rejectsLifecycle(
      harness.lifecycle.rotate(authority({ budget })),
      { category: 'UNVERIFIABLE_AUTHORITY' },
    );
    assert.equal(harness.lifecycle.phase, 'READY');
  }
});

test('lifecycle never contacts the provider for an expired or unverifiable deadline', async () => {
  for (const expiresAt of [undefined, BASE - 1, Number.NaN]) {
    const h = makeLifecycle();
    await rejectsLifecycle(
      h.lifecycle.rotate(authority({ expiresAt: expiresAt as number })),
      { category: 'UNVERIFIABLE_AUTHORITY', message: /already expired or its deadline cannot be verified/ },
    );
    assert.equal(h.lifecycle.phase, 'READY', 'an expired pre-call rejection poisoned the lifecycle');
    assert.deepEqual(h.rotations, []);
    assert.deepEqual(h.spentReads, []);
  }
});

test('lifecycle reads the counter but never posts a rotation without a safe request margin', async () => {
  const h = makeLifecycle();
  await rejectsLifecycle(
    h.lifecycle.rotate(authority({ expiresAt: BASE + 900 })),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /leaves no safe request margin/ },
  );
  assert.equal(h.lifecycle.phase, 'READY', 'a pre-call margin failure poisoned the lifecycle');
  assert.deepEqual(h.rotations, []);
  assert.equal(h.spentReads.length, 1, 'the counter read still happened before the margin check');
});

test('a successful rotation returns an exact unbound authority anchored at request time', async () => {
  const h = makeLifecycle({ advanceOnRotate: 500 });
  const rotated = await h.lifecycle.rotate(authority());
  assert.deepEqual({ ...rotated }, {
    accessToken: NEW_TOKEN,
    manageUrl: NEW_MANAGE,
    expiresAt: BASE + 600_000,
    payerId: PAYER_ID,
    resourceServerUrl: RS,
    budget: { value: '500', assetCode: 'USD', assetScale: 2 },
  });
  assert.ok(!('receiver' in rotated), 'an unbound rotation gained a receiver binding');
  assert.deepEqual(h.rotations, [{ url: OLD_MANAGE, accessToken: OLD_TOKEN }]);
  assert.deepEqual(h.spentReads, [
    { url: RS, accessToken: OLD_TOKEN },
    { url: RS, accessToken: NEW_TOKEN },
  ]);
  assert.deepEqual(h.remembered, [NEW_TOKEN, NEW_MANAGE]);
  assert.equal(h.lifecycle.phase, 'READY');
  assert.equal(h.lifecycle.blockReason, undefined);
  h.lifecycle.requireSpendable(); // must not throw
});

test('a successful rotation keeps the proven receiver binding exactly', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ receiver: RECEIVER_ID })] });
  const rotated = await h.lifecycle.rotate(authority({ receiver: RECEIVER_ID }));
  assert.deepEqual(rotated, {
    accessToken: NEW_TOKEN,
    manageUrl: NEW_MANAGE,
    expiresAt: BASE + 600_000,
    payerId: PAYER_ID,
    resourceServerUrl: RS,
    budget: { value: '500', assetCode: 'USD', assetScale: 2 },
    receiver: RECEIVER_ID,
  });
  assert.equal(h.lifecycle.phase, 'READY');
});

test('rotation evidence preserves sanitized before and after readings without exposing authority', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('20') }, { spentDebitAmount: usd('20') }] });
  await h.lifecycle.rotate(authority());
  const readings = h.lifecycle.getRotationCounterObservations();
  assert.deepEqual(readings, [
    { rotationAttempt: 1, phase: 'BEFORE', readAt: BASE, spentDebit: usd('20') },
    { rotationAttempt: 1, phase: 'AFTER', readAt: BASE, spentDebit: usd('20') },
  ]);
  assert.ok(!JSON.stringify(readings).includes(OLD_TOKEN));
  assert.ok(!JSON.stringify(readings).includes(NEW_MANAGE));
  readings[0].spentDebit.value = '999';
  assert.equal(h.lifecycle.getRotationCounterObservations()[0].spentDebit.value, '20');
});

test('rotation evidence retains observed mismatches and does not fabricate a failed after-read', async () => {
  const mismatch = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('0') }, { spentDebitAmount: usd('50') }] });
  await rejectsLifecycle(mismatch.lifecycle.rotate(authority()), { category: 'UNVERIFIABLE_COUNTER' });
  assert.deepEqual(mismatch.lifecycle.getRotationCounterObservations().map((r) => [r.phase, r.spentDebit.value]), [
    ['BEFORE', '0'], ['AFTER', '50'],
  ]);

  const failedAfter = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('0') }, new Error('secret provider detail')] });
  await rejectsLifecycle(failedAfter.lifecycle.rotate(authority()), { category: 'UNVERIFIABLE_COUNTER' });
  assert.deepEqual(failedAfter.lifecycle.getRotationCounterObservations().map((r) => r.phase), ['BEFORE']);
});

test('a consumed authority can never be reused for a second rotation', async () => {
  const h = makeLifecycle();
  await h.lifecycle.rotate(authority());
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_AUTHORITY',
    message: /already consumed by an earlier rotation/,
  });
  assert.equal(h.rotations.length, 1, 'a second rotation request reached the provider');
  assert.equal(h.lifecycle.phase, 'READY');
});

test('an authority that no longer matches the current token is refused', async () => {
  const h = makeLifecycle();
  await h.lifecycle.rotate(authority());
  await rejectsLifecycle(
    h.lifecycle.rotate(authority({ accessToken: NEW_TOKEN, manageUrl: OLD_MANAGE })),
    { category: 'UNVERIFIABLE_AUTHORITY', message: /does not match the current grant token held by this lifecycle/ },
  );
  assert.equal(h.rotations.length, 1);
});

// rotation responses that already reached the provider poison the lifecycle
test('an unknown token value poisons the lifecycle as AMBIGUOUS_ROTATION', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ omitValue: true })] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'AMBIGUOUS_ROTATION',
    message: /no usable access token value/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  assert.equal(h.lifecycle.blockReason, 'AMBIGUOUS_ROTATION');
  await rejectsLifecycle(
    Promise.resolve().then(() => h.lifecycle.requireSpendable()),
    { category: 'AMBIGUOUS_ROTATION' },
  );
});

test('a repeated token value prevents confirmation of replacement and poisons the lifecycle', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ value: OLD_TOKEN })] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'AMBIGUOUS_ROTATION',
    message: /same token value/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  assert.ok(h.remembered.includes(OLD_TOKEN), 'the repeated value was not registered for redaction');
});

test('rotated rights that differ from the accepted scope poison the lifecycle', async () => {
  const cases: { name: string; opts: RotationOptions }[] = [
    { name: 'widened actions', opts: { actions: ['create', 'read', 'read-all'] } },
    { name: 'unbound became bound', opts: { receiver: RECEIVER_ID } },
    { name: 'narrowed cap', opts: { debit: '300' } },
  ];
  for (const item of cases) {
    const h = makeLifecycle({ rotationTokens: [rotationToken(item.opts)] });
    await rejectsLifecycle(h.lifecycle.rotate(authority()), {
      category: 'UNVERIFIABLE_SCOPE',
      message: /did not revalidate against the accepted authorization|total debit cap differs/,
    });
    assert.equal(h.lifecycle.phase, 'BLOCKED', `${item.name} case did not poison`);
  }
});

test('rotated grants that lose or change the receiver restriction poison the lifecycle', async () => {
  const lostReceiver = makeLifecycle({ rotationTokens: [rotationToken()] });
  await rejectsLifecycle(lostReceiver.lifecycle.rotate(authority({ receiver: RECEIVER_ID })), {
    category: 'UNVERIFIABLE_SCOPE',
  });
  assert.equal(lostReceiver.lifecycle.phase, 'BLOCKED');
});

test('an unexpected monthly interval on a rotated grant blocks further spending', async () => {
  const h = makeLifecycle({
    rotationTokens: [rotationToken({ interval: 'R1/2026-01-01T00:00:00Z/P1M' })],
  });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), { category: 'UNVERIFIABLE_SCOPE' });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  assert.equal(h.spentReads.length, 1, 'the replacement token must not be used after scope validation failed');
  assert.throws(() => h.lifecycle.requireSpendable(), (error: unknown) => lifecycleError(error, { category: 'UNVERIFIABLE_SCOPE' }));
});

test('a rotated token without a management URI poisons the lifecycle', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ manage: null })] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_AUTHORITY',
    message: /carries no management URI/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  assert.deepEqual(h.remembered, [NEW_TOKEN]);
});

test('a rotated management URI outside the supported endpoints poisons the lifecycle', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ manage: 'https://auth.example.com/token/new' })] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_AUTHORITY',
    message: /outside the supported Test Wallet endpoints/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

test('a counter that changed across rotation poisons the lifecycle', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('0') }, { spentDebitAmount: usd('50') }] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_COUNTER',
    message: /changed across rotation/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

test('an unexpected counter reset across rotation blocks spending', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('100') }, { spentDebitAmount: usd('0') }] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_COUNTER',
    message: /changed across rotation/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  assert.throws(() => h.lifecycle.requireSpendable(), (error: unknown) => lifecycleError(error, { category: 'UNVERIFIABLE_COUNTER' }));
});

test('network delay can exhaust the advertised window and poisons the lifecycle', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ expiresIn: 1 })], advanceOnRotate: 2000 });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_AUTHORITY',
    message: /usable deadline already passed/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

test('an expiry whose milliseconds cannot be represented safely poisons the lifecycle', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ expiresIn: 1e300 })] });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'UNVERIFIABLE_SCOPE',
    message: /did not revalidate against the accepted authorization/,
  });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

// ---- spent-counter verification ----

test('verifySpentCounter accepts an idle zero reading and returns a fresh sanitized value', async () => {
  const h = makeLifecycle();
  const reading = await h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS });
  assert.deepEqual(reading, { readAt: BASE, spentDebit: { value: '0', assetCode: 'USD', assetScale: 2 } });
  assert.notStrictEqual(reading.spentDebit, (h.spentValues[0] as { spentDebitAmount: unknown }).spentDebitAmount, 'the raw provider object leaked through');
  assert.equal(h.lifecycle.phase, 'READY');
});

test('only an initial fresh-grant read may preserve explicit null/null as empty', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: null, spentReceiveAmount: null }] });
  const input = { accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS };
  assert.deepEqual(await h.lifecycle.readFreshGrantCounter(input), { kind: 'EMPTY', readAt: BASE });
  assert.equal(h.lifecycle.phase, 'READY');
  await rejectsLifecycle(h.lifecycle.readFreshGrantCounter(input), { category: 'UNVERIFIABLE_COUNTER', message: /only allowed before/ });
  await rejectsLifecycle(h.lifecycle.verifySpentCounter(input), { category: 'UNVERIFIABLE_COUNTER' });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

test('missing, partial-null and malformed fresh counters remain unverifiable', async () => {
  for (const value of [{}, { spentDebitAmount: null }, { spentDebitAmount: null, spentReceiveAmount: usd('1') }]) {
    const h = makeLifecycle({ spentValues: [value] });
    await rejectsLifecycle(h.lifecycle.readFreshGrantCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS }), { category: 'UNVERIFIABLE_COUNTER' });
    assert.equal(h.lifecycle.phase, 'BLOCKED');
  }
});

test('verifySpentCounter accepts a positive reading within the cap', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('100') }] });
  const reading = await h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS });
  assert.deepEqual(reading, { readAt: BASE, spentDebit: { value: '100', assetCode: 'USD', assetScale: 2 } });
});

test('counter readings that cannot be verified poison the lifecycle', async () => {
  const cases: { name: string; spent: unknown; message: RegExp }[] = [
    { name: 'over the cap', spent: { spentDebitAmount: usd('600') }, message: /exceeds the accepted grant cap/ },
    { name: 'null counter', spent: { spentDebitAmount: null }, message: /reported no debit spending counter/ },
    { name: 'missing counter', spent: {}, message: /missing or malformed/ },
    { name: 'malformed value', spent: { spentDebitAmount: { ...usd('5.5') } }, message: /not a valid integer minor-unit string/ },
    { name: 'wrong asset', spent: { spentDebitAmount: { ...usd('5'), assetCode: 'EUR' } }, message: /different asset or scale than the grant cap/ },
    { name: 'wrong scale', spent: { spentDebitAmount: { ...usd('5'), assetScale: 3 } }, message: /different asset or scale than the grant cap/ },
    { name: 'scale out of range', spent: { spentDebitAmount: { ...usd('5'), assetScale: 256 } }, message: /outside the supported range/ },
  ];
  for (const item of cases) {
    const h = makeLifecycle({ spentValues: [item.spent] });
    await rejectsLifecycle(
      h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS }),
      { category: 'UNVERIFIABLE_COUNTER', message: item.message },
    );
    assert.equal(h.lifecycle.phase, 'BLOCKED', `${item.name} did not poison the lifecycle`);
  }
});

test('an unreadable counter poisons the lifecycle without echoing provider detail', async () => {
  const h = makeLifecycle({ spentValues: [new Error('provider transport timeout')] });
  await rejectsLifecycle(
    h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS }),
    { category: 'UNVERIFIABLE_COUNTER', message: /could not be read/ },
  );
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

test('counter errors distinguish missing, malformed and read failures without provider text', async () => {
  const cases = [
    { value: { spentDebitAmount: null }, reason: 'MISSING_COUNTER' },
    { value: {}, reason: 'MISSING_COUNTER' },
    { value: { spentDebitAmount: usd('1.5') }, reason: 'MALFORMED_COUNTER' },
    { value: { spentDebitAmount: { ...usd('1'), assetCode: 'EUR' } }, reason: 'ASSET_MISMATCH' },
    { value: { spentDebitAmount: usd('600') }, reason: 'EXCEEDS_CAP' },
    { value: new OpenPaymentsClientError('private transport detail', { status: 403, code: 'untrusted-secret-code', description: 'secret provider detail' }), reason: 'READ_FAILED' },
  ] as const;
  for (const item of cases) {
    const h = makeLifecycle({ spentValues: [item.value] });
    const error = await h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS }).catch((e: unknown) => e);
    assert.ok(error instanceof GrantLifecycleError);
    assert.equal(error.detail?.counterReason, item.reason);
    assert.equal(error.detail?.classification, 'UNKNOWN_OUTCOME');
    assert.ok(!JSON.stringify(error.detail).includes('secret'));
    if (item.reason === 'READ_FAILED') assert.equal(error.detail?.providerStatus, 403);
    assert.equal(h.lifecycle.phase, 'BLOCKED');
  }
});

// ---- rotation failures ----

test('a definitive provider refusal is classified as ROTATION_REJECTED with whitelisted codes only', async () => {
  // 'invalid_rotation' is a protocol-enum code from the SDK's generated auth-server
  // error schema, so it is proven through; arbitrary provider text is not the
  // lifecycle's own finding and must never be copied into evidence
  const whitelisted = makeLifecycle({
    rotationFailures: [new OpenPaymentsClientError('rotation failed', { description: 'not allowed', status: 400, code: 'invalid_rotation' })],
  });
  await rejectsLifecycle(whitelisted.lifecycle.rotate(authority()), {
    category: 'ROTATION_REJECTED',
  });
  assert.equal(whitelisted.lifecycle.blockReason, 'ROTATION_REJECTED');
  assert.equal(whitelisted.lifecycle.phase, 'BLOCKED');
  const reason = (whitelisted.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked;
  assert.deepEqual(reason?.detail, {
    classification: 'DEFINITIVE_PROVIDER_REJECTION',
    providerStatus: 400,
    providerCode: 'invalid_rotation',
  });

  const arbitrary = makeLifecycle({
    rotationFailures: [new OpenPaymentsClientError('rotation failed', { description: 'not allowed', status: 400, code: 'insufficient_grant' })],
  });
  await rejectsLifecycle(arbitrary.lifecycle.rotate(authority()), {
    category: 'ROTATION_REJECTED',
  });
  const arbitraryReason = (arbitrary.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked;
  assert.deepEqual(arbitraryReason?.detail, {
    classification: 'DEFINITIVE_PROVIDER_REJECTION',
    providerStatus: 400,
  });
});

test('an OpenPayments error without a proof-backed status stays ambiguous, not definitive', async () => {
  const h = makeLifecycle({
    rotationFailures: [new OpenPaymentsClientError('rotation failed', { description: 'refused' })],
  });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), { category: 'AMBIGUOUS_ROTATION' });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
  const reason = (h.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked;
  assert.deepEqual(reason?.detail, { classification: 'UNKNOWN_OUTCOME' });
});

test('an ambiguous outcome from timeouts, 5xx, validation failures or unknown errors stays unknown', async () => {
  const ambiguous: { name: string; failure: Error }[] = [
    { name: 'timeout', failure: new OpenPaymentsClientError('request timed out', { description: 'timed out', status: 408 }) },
    { name: 'server error', failure: new OpenPaymentsClientError('request failed', { description: 'internal error', status: 500 }) },
    { name: 'validator flagged', failure: new OpenPaymentsClientError('request failed', { description: 'bad request', status: 400, validationErrors: ['limits.debitAmount'] }) },
    { name: 'transport failure', failure: new TypeError('mock transport failure') },
  ];
  for (const item of ambiguous) {
    const h = makeLifecycle({ rotationFailures: [item.failure] });
    await rejectsLifecycle(h.lifecycle.rotate(authority()), {
      category: 'AMBIGUOUS_ROTATION',
    });
    assert.equal(h.lifecycle.phase, 'BLOCKED', `${item.name} did not poison the lifecycle`);
    const reason = (h.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked;
    assert.deepEqual(reason?.detail, { classification: 'UNKNOWN_OUTCOME' }, `${item.name} detail drifted`);
  }
});

test('the first blocked reason is kept even when a later attempt would fail for another cause', async () => {
  const h = makeLifecycle({ rotationTokens: [rotationToken({ manage: null })] });
  const first = await h.lifecycle.rotate(authority()).catch((error: unknown) => error);
  lifecycleError(first, { category: 'UNVERIFIABLE_AUTHORITY', message: /carries no management URI/ });
  const second = await h.lifecycle.rotate(authority()).catch((error: unknown) => error);
  assert.strictEqual(second, first, 'the stored block reason was replaced by a new error');
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});

// ---- owner action and concurrency ----

test('markReauthRequired blocks spending with an explicit owner-action flag and keeps reads working', async () => {
  const h = makeLifecycle();
  h.lifecycle.markReauthRequired();
  assert.equal(h.lifecycle.phase, 'REAUTH_REQUIRED');
  assert.equal(h.lifecycle.blockReason, 'REAUTH_REQUIRED');
  const first = await Promise.resolve().then(() => h.lifecycle.requireSpendable()).catch((error: unknown) => error);
  lifecycleError(first, { category: 'REAUTH_REQUIRED', message: /Owner re-authorization is required/ });
  await rejectsLifecycle(h.lifecycle.rotate(authority()), { category: 'REAUTH_REQUIRED' });
  const kept = (h.lifecycle as unknown as { ownerActionRequired?: GrantLifecycleError }).ownerActionRequired;
  h.lifecycle.markReauthRequired();
  assert.strictEqual((h.lifecycle as unknown as { ownerActionRequired?: GrantLifecycleError }).ownerActionRequired, kept, 'a second mark replaced the flag');
  const reading = await h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS });
  assert.equal(reading.spentDebit.value, '0', 'counter reads stopped working under the reauth flag');
});

test('a real block is not replaced by the reauth flag', async () => {
  const h = makeLifecycle({ spentValues: [{ spentDebitAmount: usd('600') }] });
  await rejectsLifecycle(
    h.lifecycle.verifySpentCounter({ accessToken: OLD_TOKEN, budget: usd('500'), resourceServerUrl: RS }),
    { category: 'UNVERIFIABLE_COUNTER' },
  );
  const blocked = (h.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked;
  h.lifecycle.markReauthRequired();
  assert.equal(h.lifecycle.blockReason, 'UNVERIFIABLE_COUNTER', 'the reauth flag overwrote a concrete block');
  assert.strictEqual((h.lifecycle as unknown as { blocked?: GrantLifecycleError }).blocked, blocked);
});

test('only one rotation may be in flight; a second is refused and spending must wait', async () => {
  const h = makeLifecycle();
  const gate = deferredRotation();
  h.rotationDeferred = gate;
  const first = h.lifecycle.rotate(authority());
  assert.equal(h.lifecycle.phase, 'ROTATION_IN_FLIGHT');
  await rejectsLifecycle(h.lifecycle.rotate(authority()), {
    category: 'ROTATION_BUSY',
    message: /Another token rotation is already in flight/,
  });
  assert.equal(h.lifecycle.blockReason, undefined, 'a busy rotation was remembered as a block');
  await rejectsLifecycle(Promise.resolve().then(() => h.lifecycle.requireSpendable()), {
    category: 'ROTATION_BUSY',
    message: /spending must wait/,
  });
  gate.settle(rotationToken());
  const rotated = await first;
  assert.equal(rotated.accessToken, NEW_TOKEN);
  assert.deepEqual(h.rotations, [{ url: OLD_MANAGE, accessToken: OLD_TOKEN }]);
  assert.equal(h.lifecycle.phase, 'READY');
});

test('a deferred rotation whose outcome stays unknown rejects as ambiguous', async () => {
  const h = makeLifecycle();
  const gate = deferredRotation();
  h.rotationDeferred = gate;
  const first = h.lifecycle.rotate(authority());
  gate.settle(new TypeError('mock transport failure'));
  await rejectsLifecycle(first, { category: 'AMBIGUOUS_ROTATION' });
  assert.equal(h.lifecycle.phase, 'BLOCKED');
});
