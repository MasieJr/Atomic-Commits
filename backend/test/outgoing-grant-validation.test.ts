import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GrantWithAccessToken } from '@interledger/open-payments';

import {
  validateReturnedOutgoingGrant,
  type IntendedOutgoingApproval,
  type ReturnedOutgoingAccessEntry,
  type ReturnedOutgoingLimits,
} from '../src/services/outgoing-grant-validation';
import type { Amount } from '../src/services/payment-proof-run';

// Test Wallet shaped endpoints; no real provider and no network calls
const PAYER = 'https://wallet.interledger-test.dev/payer';
const OTHER_WALLET = 'https://wallet.interledger-test.dev/other-payer';
const RECEIVER = 'https://wallet.interledger-test.dev/receiver';
const OTHER_RECEIVER = 'https://wallet.interledger-test.dev/other-receiver';

// distinctive fake secrets prove no token value is ever echoed in an error
const ACCESS_TOKEN_SECRET = 'AT-VALIDATOR-FIXTURE-TOKEN';
const CONTINUATION_SECRET = 'CONT-VALIDATOR-FIXTURE-TOKEN';

function usd(value: string, assetCode = 'USD', assetScale = 2): Amount {
  return { value, assetCode, assetScale };
}

function asAmount(raw: unknown): Amount {
  return raw as unknown as Amount;
}

function intended(overrides?: Partial<IntendedOutgoingApproval> | null): IntendedOutgoingApproval {
  if (overrides === null) return null as unknown as IntendedOutgoingApproval;
  const requested: Partial<IntendedOutgoingApproval> = overrides ?? {};
  // an explicitly-undefined key in the override removes the base value,
  // matching how a missing field reaches the validator
  return { payerId: PAYER, requestedDebit: usd('500'), ...requested } as IntendedOutgoingApproval;
}

function freshIntended(approval?: { receiver?: string }): IntendedOutgoingApproval {
  return intended(approval ? { requestedReceiver: approval.receiver } : {});
}

// an SDK-shaped fixture: exact returned scope, matching caps, fresh expiry
function freshGrant(fixed?: { identifier?: string; receiver?: string }): GrantWithAccessToken {
  const limits: ReturnedOutgoingLimits = {
    debitAmount: usd('500'),
    ...(fixed?.receiver ? { receiver: fixed.receiver } : {}),
  };
  return {
    access_token: {
      value: ACCESS_TOKEN_SECRET,
      manage: 'https://auth.interledger-test.dev/token/1',
      expires_in: 600,
      access: [
        {
          type: 'outgoing-payment',
          actions: ['create', 'read'],
          identifier: fixed?.identifier ?? PAYER,
          limits,
        },
      ],
    },
    continue: {
      access_token: { value: CONTINUATION_SECRET },
      uri: 'https://auth.interledger-test.dev/continue/1',
    },
  };
}

// recast only deliberately malformed fixture data; valid shapes stay SDK-typed
type GrantFixer = (entry: ReturnedOutgoingAccessEntry, grant: GrantWithAccessToken) => void;
function malformed(fix: GrantFixer): GrantWithAccessToken {
  const grant = freshGrant();
  fix(grant.access_token.access[0] as unknown as ReturnedOutgoingAccessEntry, grant);
  return grant as unknown as GrantWithAccessToken;
}

function withLimits(raw: unknown): GrantWithAccessToken {
  return malformed((entry) => {
    entry.limits = raw as unknown as ReturnedOutgoingLimits;
  });
}

function withActions(actions: unknown): GrantWithAccessToken {
  return malformed((entry) => {
    entry.actions = actions as unknown as ReturnedOutgoingAccessEntry['actions'];
  });
}

function reject(grant: GrantWithAccessToken, approval: IntendedOutgoingApproval, pattern: RegExp): void {
  assert.throws(
    () => validateReturnedOutgoingGrant(grant, approval),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'rejection must be an Error');
      // semantic match keeps wording corrections from breaking the suite
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(ACCESS_TOKEN_SECRET), 'access token leaked in error');
      assert.ok(!error.message.includes(CONTINUATION_SECRET), 'continuation token leaked in error');
      return true;
    },
    `expected rejection matching ${String(pattern)}`,
  );
}

// ---------- accepted shapes ----------

test('accepts the exact receiver-bound grant that was requested (Proof A)', () => {
  const grant = freshGrant({ receiver: RECEIVER });
  const validated = validateReturnedOutgoingGrant(grant, freshIntended({ receiver: RECEIVER }));

  // budget and limits are fresh sanitized Money: value re-serialized from the
  // parsed exact integer, and the sanitized limits carry the same budget object
  assert.deepEqual(validated.budget, usd('500'));
  assert.equal(validated.budget, validated.limits.debitAmount);
  assert.deepEqual(validated.limits, { debitAmount: usd('500'), receiver: RECEIVER });
  assert.equal(validated.expiresInSeconds, 600);
});

test('accepts the deliberately-unrestricted grant when nothing was bound (Proof B)', () => {
  const grant = freshGrant();
  const validated = validateReturnedOutgoingGrant(grant, freshIntended());

  assert.deepEqual(validated.budget, usd('500'));
  assert.deepEqual(validated.budget, validated.limits.debitAmount);
  assert.deepEqual(validated.limits, { debitAmount: usd('500') });
  assert.equal(validated.limits.receiver, undefined);
  assert.equal(validated.expiresInSeconds, 600);
});

test('accepts a provider-narrowed budget and reports the provider cap, never the request', () => {
  const narrowedDebit = usd('300');
  const grant = withLimits({ debitAmount: narrowedDebit });
  const validated = validateReturnedOutgoingGrant(grant, freshIntended());

  assert.deepEqual(validated.budget, usd('300'));
  assert.notEqual(validated.budget, narrowedDebit); // sanitized, not the raw provider object
});

// ---------- null/malformed grant and token shapes ----------

test('rejects a null grant with a constant fail-closed error', () => {
  reject(null as unknown as GrantWithAccessToken, freshIntended(), /no verifiable grant for the outgoing payment/);
});

test('rejects null and missing access tokens with a constant fail-closed error', () => {
  reject({ ...freshGrant(), access_token: null } as unknown as GrantWithAccessToken, freshIntended(), /no verifiable access token/);
  const missingToken = malformed((_entry, g) => {
    delete (g as unknown as Record<string, unknown>).access_token;
  });
  reject(missingToken, freshIntended(), /no verifiable access token/);
});

// ---------- access scope list ----------

test('rejects a zero-entry access scope list', () => {
  const grant = malformed((_entry, g) => {
    (g.access_token as unknown as Record<string, unknown>).access = [];
  });
  reject(grant, freshIntended(), /does not match the single requested outgoing-payment scope/);
});

test('rejects an extra access entry beyond the one requested', () => {
  const grant = malformed((entry, g) => {
    (g.access_token as unknown as Record<string, unknown>).access = [
      entry,
      entry as unknown as GrantWithAccessToken['access_token']['access'][number],
    ];
  });
  reject(grant, freshIntended(), /does not match the single requested outgoing-payment scope/);
});

test('rejects a single malformed null access entry', () => {
  const grant = malformed((_entry, g) => {
    (g.access_token as unknown as Record<string, unknown>).access = [null];
  });
  reject(grant, freshIntended(), /does not carry exactly one outgoing-payment scope/);
});

test('rejects a single access entry of the wrong access type', () => {
  const grant = malformed((_entry, g) => {
    (g.access_token as unknown as Record<string, unknown>).access = [{ type: 'quote', actions: ['create', 'read'] }];
  });
  reject(grant, freshIntended(), /does not carry exactly one outgoing-payment scope/);
});

test('rejects a non-array access scope list', () => {
  const grant = malformed((_entry, g) => {
    (g.access_token as unknown as Record<string, unknown>).access = 'outgoing-payment';
  });
  reject(grant, freshIntended(), /does not match the single requested outgoing-payment scope/);
});

test('rejects access for a wallet other than the intended payer', () => {
  reject(freshGrant({ identifier: OTHER_WALLET }), freshIntended(), /wallet other than the intended payer/);
});

test('rejects a missing outgoing-payment identifier entirely', () => {
  const grant = malformed((entry, g) => {
    const naked = entry as unknown as Record<string, unknown>;
    delete naked.identifier;
    (g.access_token.access as unknown as Record<string, unknown>[])[0] = naked;
  });
  reject(grant, freshIntended(), /wallet other than the intended payer/);
});

// ---------- actions ----------

function assertActionReject(grant: GrantWithAccessToken): void {
  reject(grant, freshIntended(), /actions other than exactly create and read/);
}

test('rejects a single action (create without read)', () => assertActionReject(withActions(['create'])));
test('rejects a single action (read without create)', () => assertActionReject(withActions(['read'])));
test('rejects a wrong second action (create and read-all)', () => assertActionReject(withActions(['create', 'read-all'])));
test('rejects an extra action beyond create and read', () => assertActionReject(withActions(['create', 'read', 'read-all'])));
test('rejects substitute actions carrying both list-all forms', () => {
  assertActionReject(withActions(['create', 'list-all']));
  assertActionReject(withActions(['read', 'list-all']));
});
test('rejects an empty actions list', () => assertActionReject(withActions([])));
test('rejects a missing actions field', () => assertActionReject(withActions(undefined)));

// ---------- spending limits ----------

test('rejects a grant with no returned limits at all', () => {
  const grant = malformed((entry) => {
    delete (entry as unknown as Record<string, unknown>).limits;
  });
  reject(grant, freshIntended(), /no usable spending limits/);
});

test('rejects returned limits that are not an object at all', () => {
  reject(withLimits(null), freshIntended(), /no usable spending limits/);
});

test('rejects limits that carry no debit cap (receiver-only form)', () => {
  reject(withLimits({ receiver: RECEIVER }), freshIntended(), /no debit cap/);
});

test('rejects a returned debit cap wider than the request', () => {
  reject(withLimits({ debitAmount: usd('1000') }), freshIntended(), /larger than the requested budget/);
});

test('rejects a returned debit cap with a zero value', () => {
  reject(withLimits({ debitAmount: usd('0') }), freshIntended(), /must be a positive minor-unit value/);
});

test('rejects a negative returned debit value as an invalid integer string', () => {
  reject(withLimits({ debitAmount: usd('-500') }), freshIntended(), /not a valid integer minor-unit string/);
});

test('rejects a fractional returned debit value', () => {
  reject(withLimits({ debitAmount: usd('5.50') }), freshIntended(), /not a valid integer minor-unit string/);
});

test('rejects a returned debit value broken by a leading zero', () => {
  reject(withLimits({ debitAmount: usd('0500') }), freshIntended(), /not a valid integer minor-unit string/);
});

test('rejects a returned debit amount that is not an integer string', () => {
  reject(
    withLimits({ debitAmount: asAmount({ value: 500, assetCode: 'USD', assetScale: 2 }) }),
    freshIntended(),
    /not an exact integer string/,
  );
});

test('rejects a returned debit amount with no asset code', () => {
  reject(
    withLimits({ debitAmount: asAmount({ value: '500', assetCode: '', assetScale: 2 }) }),
    freshIntended(),
    /carries no asset code/,
  );
});

test('rejects a returned debit amount with a malformed asset scale', () => {
  reject(
    withLimits({ debitAmount: asAmount({ value: '500', assetCode: 'USD', assetScale: -1 }) }),
    freshIntended(),
    /asset scale is malformed or outside the supported range/,
  );
});

test('rejects a returned debit amount that is not an object at all', () => {
  reject(withLimits({ debitAmount: null }), freshIntended(), /The returned debit amount is missing or malformed/);
});

// ---------- asset and scale bounds (0..255) ----------

test('rejects a returned debit cap with a scale above 255', () => {
  reject(
    withLimits({ debitAmount: usd('500', 'USD', 256) }),
    freshIntended(),
    /asset scale is malformed or outside the supported range/,
  );
});

test('rejects a requested debit with a scale above 255 before consulting the provider', () => {
  const grant = malformed((entry) => {
    entry.limits = { debitAmount: usd('500') }; // grant is otherwise exact and valid
  });
  reject(grant, intended({ requestedDebit: usd('500', 'USD', 300) }), /requested debit amount asset scale/);
});

test('rejects a different asset code', () => {
  reject(withLimits({ debitAmount: usd('500', 'EUR', 2) }), freshIntended(), /different asset or scale/);
});

test('rejects a different asset scale', () => {
  reject(withLimits({ debitAmount: usd('500', 'USD', 6) }), freshIntended(), /different asset or scale/);
});

// ---------- receiver restrictions ----------

test('rejects the receiver restriction dropped from a receiver-bound grant', () => {
  reject(withLimits({ debitAmount: usd('500') }), freshIntended({ receiver: RECEIVER }), /omitted the requested receiver restriction/);
});

test('rejects a different receiver than requested', () => {
  reject(freshGrant({ receiver: OTHER_RECEIVER }), freshIntended({ receiver: RECEIVER }), /receiver restriction different from the one requested/);
});

test('rejects a receiver bound onto a deliberately-unrestricted grant', () => {
  reject(freshGrant({ receiver: RECEIVER }), freshIntended(), /bound the unrestricted grant/);
});

test('rejects an empty-string requested receiver as a malformed approval description', () => {
  reject(freshGrant({ receiver: RECEIVER }), freshIntended({ receiver: '' }), /must be an address string or deliberately absent/);
});

// ---------- unrequested limit fields (constant, data-free rejection) ----------

test('rejects interval restrictions that were never requested by field name, not value', () => {
  reject(
    withLimits({ debitAmount: usd('500'), interval: 'R/2026-01-01T00:00:00Z/PT1M-SPEND-EVERYTHING' }),
    freshIntended(),
    /unrequested limit fields/,
  );
});

test('rejects a fully unknown limits key whose semantics cannot be verified', () => {
  reject(
    withLimits({ debitAmount: usd('500'), spendEverything: 'TRUE-WITH-NO-LIMIT' }),
    freshIntended(),
    /unrequested limit fields/,
  );
});

test('rejects receive-amount limits as unrequested fields with no debit-cap trust', () => {
  reject(withLimits({ receiveAmount: usd('10') }), freshIntended(), /unrequested limit fields/);
  reject(
    withLimits({ debitAmount: usd('500'), receiveAmount: usd('10') }),
    freshIntended(),
    /unrequested limit fields/,
  );
});

test('the unknown-limits rejection echoes no provider key or value', () => {
  const grant = withLimits({ debitAmount: usd('500'), interval: 'R/P1D/SECRET-INTERVAL-SEMANTICS' });
  assert.throws(
    () => validateReturnedOutgoingGrant(grant, freshIntended()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('interval'), 'limit key name leaked');
      assert.ok(!error.message.includes('SECRET-INTERVAL-SEMANTICS'), 'limit value leaked');
      assert.ok(!error.message.includes('debitAmount'), 'limit key name leaked');
      assert.match(error.message, /unrequested limit fields/);
      return true;
    },
  );
});

// ---------- expiry ----------

function assertExpiryReject(fixExpiry: (grant: GrantWithAccessToken) => void): void {
  const grant = freshGrant();
  fixExpiry(grant);
  reject(grant, freshIntended(), /finite positive expiry that yields safe integer milliseconds/);
}

test('rejects a missing expiry advertisement', () => {
  assertExpiryReject((g) => {
    delete (g.access_token as unknown as Record<string, unknown>).expires_in;
  });
});

test('rejects a zero expiry', () => assertExpiryReject((g) => { g.access_token.expires_in = 0; }));
test('rejects a negative expiry', () => assertExpiryReject((g) => { g.access_token.expires_in = -600; }));
test('rejects a NaN expiry', () => assertExpiryReject((g) => { g.access_token.expires_in = Number.NaN; }));
test('rejects an infinite expiry', () => assertExpiryReject((g) => { g.access_token.expires_in = Number.POSITIVE_INFINITY; }));
test('rejects a non-numeric expiry', () => assertExpiryReject((g) => { g.access_token.expires_in = '600' as unknown as number; }));

test('rejects an enormous positive expiry whose millisecond product is not a safe integer', () => {
  // 1e300 seconds is finite and positive, but 1e303 ms exceeds Number.MAX_SAFE_INTEGER
  assertExpiryReject((g) => { g.access_token.expires_in = 1e300; });
});

// ---------- approved-intent description ----------

test('rejects a malformed intended approval with no description at all', () => {
  reject(freshGrant(), intended(null), /must be described to validate a returned grant/);
});

test('rejects a missing or empty intended payer identifier', () => {
  reject(freshGrant(), intended({ payerId: undefined as unknown as string }), /payer wallet identifier is missing/);
  reject(freshGrant(), intended({ payerId: '' }), /payer wallet identifier is missing/);
});

test('rejects a malformed intended requested debit', () => {
  reject(freshGrant(), intended({ requestedDebit: null as unknown as Amount }), /The requested debit amount is missing or malformed/);
  reject(freshGrant(), intended({ requestedDebit: usd('0') }), /The requested debit amount must be a positive minor-unit value/);
  reject(
    freshGrant(),
    intended({ requestedDebit: asAmount({ value: '05', assetCode: 'USD', assetScale: 2 }) }),
    /The requested debit amount is not a valid integer minor-unit string/,
  );
});

// ---------- sanitized result guarantees ----------

test('extra money properties on the returned cap are not copied into the sanitized result', () => {
  const grant = withLimits({
    debitAmount: asAmount({ value: '300', assetCode: 'USD', assetScale: 2, maximumValue: '999999', note: 'provider-noise' }),
  });
  const validated = validateReturnedOutgoingGrant(grant, freshIntended());

  assert.deepEqual(validated.budget, { value: '300', assetCode: 'USD', assetScale: 2 });
  assert.deepEqual(validated.limits, { debitAmount: { value: '300', assetCode: 'USD', assetScale: 2 } });
  const serialized = JSON.stringify(validated);
  assert.ok(!serialized.includes('maximumValue'));
  assert.ok(!serialized.includes('provider-noise'));
});

test('sanitized results stay intact when the source grant is mutated afterwards', () => {
  const grant = freshGrant({ receiver: RECEIVER });
  const validated = validateReturnedOutgoingGrant(grant, freshIntended({ receiver: RECEIVER }));
  const before = JSON.stringify(validated);

  // corrupt every field the sanitized result was built from
  (grant.access_token.access[0] as unknown as { limits?: unknown }).limits = { debitAmount: usd('999') };
  (grant.access_token.access[0] as unknown as Record<string, unknown>).identifier = OTHER_WALLET;
  grant.access_token.expires_in = 0;
  (grant.access_token.access as unknown as unknown[]).push({ type: 'quote', actions: ['create'] });

  assert.equal(JSON.stringify(validated), before);
  assert.deepEqual(validated.budget, usd('500'));
  assert.deepEqual(validated.limits, { debitAmount: usd('500'), receiver: RECEIVER });
  assert.equal(validated.expiresInSeconds, 600);
  // receiver in the sanitized limits is proven by the request, not the mutated source
  assert.equal((validated.limits as { receiver?: string }).receiver, RECEIVER);
});

// ---------- secrets ----------

test('never echoes access-token or continuation secrets in any rejection', () => {
  // a representative slice of every rejection family, all seeded with the same fake secrets
  const badGrants: GrantWithAccessToken[] = [
    null as unknown as GrantWithAccessToken,
    { ...freshGrant(), access_token: null } as unknown as GrantWithAccessToken,
    freshGrant({ identifier: OTHER_WALLET }),
    malformed((entry, g) => {
      (g.access_token as unknown as Record<string, unknown>).access = [
        entry,
        entry as unknown as GrantWithAccessToken['access_token']['access'][number],
      ];
    }),
    withLimits({ debitAmount: usd('1000') }),
    malformed((entry) => {
      delete (entry as unknown as Record<string, unknown>).limits;
    }),
    withLimits({ debitAmount: usd('0') }),
    withLimits({ debitAmount: usd('500', 'EUR', 2) }),
    withActions(['create']),
    withLimits({ debitAmount: usd('500'), interval: 'R/2026-01-01T00:00:00Z/P1M' }),
    freshGrant({ receiver: OTHER_RECEIVER }), // wrong receiver for a receiver-bound intent
    freshGrant({ receiver: RECEIVER }), // bound where nothing was requested
  ];
  const approvals = [
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended(),
    freshIntended({ receiver: RECEIVER }),
    freshIntended(),
  ];

  for (const [index, badGrant] of badGrants.entries()) {
    // every rejection must name no fixture secret material
    assert.throws(
      () => validateReturnedOutgoingGrant(badGrant, approvals[index]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(ACCESS_TOKEN_SECRET), 'access token leaked in error');
        assert.ok(!error.message.includes(CONTINUATION_SECRET), 'continuation token leaked in error');
        return true;
      },
      `rejection ${String(index)} leaked a secret`,
    );
  }

  // the valid path result carries no token material either
  const validated = validateReturnedOutgoingGrant(freshGrant({ receiver: RECEIVER }), freshIntended({ receiver: RECEIVER }));
  const serialized = JSON.stringify(validated);
  assert.ok(!serialized.includes(ACCESS_TOKEN_SECRET));
  assert.ok(!serialized.includes(CONTINUATION_SECRET));
});
