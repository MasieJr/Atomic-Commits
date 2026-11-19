// L3 contract tests — identity/status partition, sanitized events, idempotency.
// In-memory fakes only; no Express, pg, Supabase, FCM, or Open Payments SDK.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPaymentStatus,
  isInProgressStatus,
  isTerminalStatus,
  isUnresolvedStatus,
  isValidUserId,
  isPayloadSanitized,
  makeMoney,
  NON_TERMINAL_PAYMENT_STATUSES,
  PAYMENT_STATUSES,
  TERMINAL_PAYMENT_STATUSES,
  UNRESOLVED_PAYMENT_STATUSES,
  IN_PROGRESS_PAYMENT_STATUSES,
  type SanitizedEventPayload,
  type SanitizedPaymentEvent,
  type PaymentStatus,
} from "../src/domain/payment-engine/index";
import type {
  IdempotencyResolution,
  IdempotencyResolutionView,
  PaymentRepositoryPort,
} from "../src/domain/payment-engine/index";

// ---------------- UserId ----------------

test("isValidUserId accepts only positive safe integers", () => {
  assert.equal(isValidUserId(1), true);
  assert.equal(isValidUserId(Number.MAX_SAFE_INTEGER), true);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -0, 1e-9]) {
    assert.equal(isValidUserId(bad), false, `rejected: ${bad}`);
  }
  for (const notNumber of ["1", " 1", null, undefined, true, {}, []]) {
    assert.equal(isValidUserId(notNumber), false);
  }
});

// ---------------- Status partition ----------------

const EXPECTED_STATUSES: readonly PaymentStatus[] = [
  "AWAITING_AUTHORIZATION",
  "SUBMITTING",
  "PROCESSING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
];

test("status union is the documented closed seven-value set", () => {
  assert.equal(PAYMENT_STATUSES.length, 7);
  assert.deepEqual(new Set<string>(PAYMENT_STATUSES), new Set<string>(EXPECTED_STATUSES));
  for (const status of EXPECTED_STATUSES) assert.equal(isPaymentStatus(status), true);
  assert.equal(isPaymentStatus("PENDING"), false);
  assert.equal(isPaymentStatus(""), false);
  assert.equal(isPaymentStatus("succeeded"), false);
  assert.equal(isPaymentStatus(undefined), false);
});

test("status partition: in-progress vs unresolved vs terminal is exact", () => {
  assert.deepEqual([...IN_PROGRESS_PAYMENT_STATUSES].sort(), ["AWAITING_AUTHORIZATION", "PROCESSING", "SUBMITTING"]);
  assert.deepEqual([...TERMINAL_PAYMENT_STATUSES].sort(), ["FAILED", "REJECTED", "SUCCEEDED"]);
  assert.equal(UNRESOLVED_PAYMENT_STATUSES.length, 1);
  // NON_TERMINAL = IN_PROGRESS + UNRESOLVED, disjoint sets
  assert.equal(NON_TERMINAL_PAYMENT_STATUSES.length, 4);
  // Every status belongs to exactly one of [in-progress | unresolved | terminal]
  const inProgress = new Set<string>(IN_PROGRESS_PAYMENT_STATUSES);
  const unresolved = new Set<string>(UNRESOLVED_PAYMENT_STATUSES);
  const terminal = new Set<string>(TERMINAL_PAYMENT_STATUSES);
  for (const status of PAYMENT_STATUSES) {
    const count =
      (inProgress.has(status) ? 1 : 0) +
      (unresolved.has(status) ? 1 : 0) +
      (terminal.has(status) ? 1 : 0);
    assert.equal(count, 1, `status ${status} must belong to exactly one partition bucket`);
  }
});

test("UNKNOWN is unresolved, not terminal, not in-progress", () => {
  assert.equal(isUnresolvedStatus("UNKNOWN"), true);
  assert.equal(isTerminalStatus("UNKNOWN"), false);
  assert.equal(isInProgressStatus("UNKNOWN"), false);
  assert.equal(isUnresolvedStatus("FAILED"), false);
  assert.equal(isTerminalStatus("SUCCEEDED"), true);
  assert.equal(isInProgressStatus("PROCESSING"), true);
});

// Type-level: distinct money roles compile exactly where intended.
const payerDebit = makeMoney("100", "USD", 2);
const merchantReceive = makeMoney("95", "USD", 2);
const distinctRoleMoney: {
  readonly payerDebit: MoneyRoleDebit;
  readonly merchantReceive: MoneyRoleReceive;
} = { payerDebit, merchantReceive };
assert.ok(distinctRoleMoney.payerDebit !== distinctRoleMoney.merchantReceive);
type MoneyRoleDebit = typeof payerDebit;
type MoneyRoleReceive = typeof merchantReceive;

// ---------------- Sanitized event payloads ----------------

const moneyAmount = makeMoney("250", "USD", 2);

test("isPayloadSanitized accepts all seven payload kinds", () => {
  const payloads: readonly unknown[] = [
    { kind: "status", status: "SUCCEEDED" },
    { kind: "money", side: "PAYER_DEBIT", amount: moneyAmount },
    { kind: "money", side: "MERCHANT_RECEIVE", amount: moneyAmount },
    { kind: "money", side: "UNSPECIFIED", amount: moneyAmount },
    { kind: "failure", code: "PAYMENT_OUTCOME_UNKNOWN" },
    { kind: "quote", quoteProviderRef: "q-123" },
    { kind: "attempt", attemptProviderRef: "a-123" },
    { kind: "claim", instructionId: "i-1", nonce: "n-1" },
    { kind: "none" },
  ];
  for (const payload of payloads) {
    assert.equal(isPayloadSanitized(payload), true, `accepted: ${JSON.stringify(payload)}`);
  }
});

test("isPayloadSanitized rejects unknown kind, extra keys, missing/wrong fields, malformed money, non-whitelisted codes", () => {
  const rejections: readonly unknown[] = [
    { kind: "raw_text", text: "provider said something scary" },
    { kind: "provider_error", body: "boom" },
    {}, // missing kind
    { kind: "status", status: "PENDING" },
    { kind: "status", status: "SUCCEEDED", extra: "smuggled" },
    { kind: "money", side: "PAYER_DEBIT" }, // missing amount
    { kind: "money", side: "PAYER_DEBIT", amount: { value: 250, assetCode: "USD", assetScale: 2 } },
    { kind: "money", side: "WRONG_SIDE", amount: moneyAmount },
    { kind: "failure", code: "PROVIDER_TIMEOUT" }, // outside the closed union
    { kind: "failure" },
    { kind: "quote" }, // missing ref
    { kind: "attempt", attemptProviderRef: "" },
    { kind: "claim", instructionId: "i-1" }, // missing nonce
    [{ kind: "none" }], // arrays rejected
    "none",
    null,
    undefined,
  ];
  for (const payload of rejections) {
    assert.equal(isPayloadSanitized(payload), false, `rejected: ${JSON.stringify(payload)}`);
  }
});

// ---------------- Event sink: exactly once per (userId, eventId) ----------------

type RecordedEvent = {
  readonly eventId: string;
  readonly userId: number;
  readonly type: string;
};

/** In-memory PaymentEventsPort fake: refuses a duplicate (userId, eventId). */
class InMemoryEventSink {
  private readonly seenByPair = new Map<string, true>();

  readonly events: RecordedEvent[] = [];

  asPort(): { record(event: SanitizedPaymentEvent): Promise<void> } {
    return {
      record: async (event: SanitizedPaymentEvent): Promise<void> => {
        const pairKey = `${event.userId}::${event.eventId}`;
        if (this.seenByPair.has(pairKey)) {
          throw new Error(`duplicate payment event: userId=${event.userId} eventId=${event.eventId}`);
        }
        this.seenByPair.set(pairKey, true);
        this.events.push({ eventId: event.eventId, userId: event.userId, type: event.type });
      },
    };
  }
}

function fakeEvent(
  userId: number,
  eventId: string,
  type: SanitizedPaymentEvent["type"],
  payload: SanitizedEventPayload
): SanitizedPaymentEvent {
  return {
    eventId,
    userId,
    paymentId: "payment-1",
    type,
    occurredAtEpochMs: 1700000000000,
    payload,
  };
}

test("event sink enforces once-only (userId, eventId) and records exactly one event on retry", async () => {
  const sink = new InMemoryEventSink();
  const port = sink.asPort();
  const first = fakeEvent(7, "evt-1", "PAYMENT_SUCCEEDED", { kind: "none" });
  await port.record(first);
  const duplicateRetry = fakeEvent(7, "evt-1", "PAYMENT_SUCCEEDED", { kind: "none" }); // same identity, same payload
  await assert.rejects(() => port.record(duplicateRetry), /duplicate payment event/);
  const crossUser = fakeEvent(8, "evt-1", "PAYMENT_SUCCEEDED", { kind: "none" });
  await port.record(crossUser); // different user, same eventId: allowed
  assert.equal(sink.events.length, 2);
  assert.deepEqual(
    sink.events.map((event) => [event.userId, event.eventId]),
    [[7, "evt-1"], [8, "evt-1"]]
  );
});

// ---------------- Idempotency ----------------

const FINGERPRINT_AB = "1f".repeat(32);
const FINGERPRINT_CD = "2f".repeat(32);

interface StoredResolution {
  readonly userId: number;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly resolution: IdempotencyResolution;
}

/** In-memory repository fake implementing PaymentRepositoryPort idempotency half. */
class InMemoryIdempotencyRepository {
  private readonly records: StoredResolution[] = [];

  findIdempotentResolution(args: {
    readonly userId: number;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  }): Promise<IdempotencyResolutionView | undefined> {
    const record = this.records.find(
      (stored) =>
        stored.userId === args.userId &&
        stored.idempotencyKey === args.idempotencyKey
    );
    if (record === undefined) return Promise.resolve(undefined);
    if (record.requestFingerprint === args.requestFingerprint) {
      assert.ok(record.resolution.kind === "PREVIOUS" || record.resolution.kind === "CONFLICT");
      return Promise.resolve(record.resolution);
    }
    return Promise.resolve({ kind: "CONFLICT", conflictCode: "IDEMPOTENCY_CONFLICT" });
  }

  createIdempotentResolution(args: {
    readonly userId: number;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly paymentId: string;
    readonly attemptId: string;
  }): Promise<IdempotencyResolutionView> {
    const existing = this.records.find(
      (stored) => stored.userId === args.userId && stored.idempotencyKey === args.idempotencyKey
    );
    if (existing !== undefined) {
      assert.equal(existing.userId, args.userId);
      return existing.requestFingerprint === args.requestFingerprint
        ? Promise.resolve(existing.resolution)
        : Promise.resolve({ kind: "CONFLICT", conflictCode: "IDEMPOTENCY_CONFLICT" });
    }
    const created: StoredResolution = {
      userId: args.userId,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: args.requestFingerprint,
      resolution: {
        kind: "PREVIOUS",
        paymentId: args.paymentId,
        attemptId: args.attemptId,
        status: "AWAITING_AUTHORIZATION",
      },
    };
    this.records.push(created);
    return Promise.resolve(created.resolution);
  }

  get size(): number {
    return this.records.length;
  }
}

test("in-memory idempotency: same user+key+same fingerprint resolves to PREVIOUS", async () => {
  const repository = new InMemoryIdempotencyRepository();
  const first = await repository.createIdempotentResolution({
    userId: 1,
    idempotencyKey: "key-a",
    requestFingerprint: FINGERPRINT_AB,
    paymentId: "payment-1",
    attemptId: "attempt-1",
  });
  const second = await repository.findIdempotentResolution({
    userId: 1,
    idempotencyKey: "key-a",
    requestFingerprint: FINGERPRINT_AB,
  });
  assert.deepEqual(second, first);
  assert.equal(second?.kind, "PREVIOUS");
  const retriedCreate = await repository.createIdempotentResolution({
    userId: 1,
    idempotencyKey: "key-a",
    requestFingerprint: FINGERPRINT_AB,
    paymentId: "payment-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(retriedCreate, first);
  assert.equal(repository.size, 1, "no new record created for the same fingerprint");
});

test("in-memory idempotency: different fingerprint resolves to CONFLICT", async () => {
  const repository = new InMemoryIdempotencyRepository();
  await repository.createIdempotentResolution({
    userId: 1,
    idempotencyKey: "key-b",
    requestFingerprint: FINGERPRINT_AB,
    paymentId: "payment-2",
    attemptId: "attempt-2",
  });
  const conflicting = await repository.findIdempotentResolution({
    userId: 1,
    idempotencyKey: "key-b",
    requestFingerprint: FINGERPRINT_CD,
  });
  assert.deepEqual(conflicting, { kind: "CONFLICT", conflictCode: "IDEMPOTENCY_CONFLICT" });
  // CONFLICT never leaks the original payment/attempt ids.
  assert.ok(!JSON.stringify(conflicting).includes("payment-2"));
  assert.ok(!JSON.stringify(conflicting).includes("attempt-2"));
});

test("in-memory idempotency: users never leak each other's key, payment, or attempt", async () => {
  const repository = new InMemoryIdempotencyRepository();
  const ownerView = await repository.createIdempotentResolution({
    userId: 10,
    idempotencyKey: "shared-key",
    requestFingerprint: FINGERPRINT_AB,
    paymentId: "payment-owner",
    attemptId: "attempt-owner",
  });
  const foreignView = await repository.findIdempotentResolution({
    userId: 11,
    idempotencyKey: "shared-key",
    requestFingerprint: FINGERPRINT_AB,
  });
  assert.equal(foreignView, undefined);
  assert.equal(repository.size, 1);
  const foreignCreate = await repository.createIdempotentResolution({
    userId: 11,
    idempotencyKey: "shared-key",
    requestFingerprint: FINGERPRINT_AB,
    paymentId: "payment-foreign",
    attemptId: "attempt-foreign",
  });
  assert.equal(foreignCreate.kind, "PREVIOUS");
  assert.equal(
    (foreignCreate as { paymentId: string }).paymentId,
    "payment-foreign",
    "foreign user got their own record"
  );
  assert.notDeepEqual(foreignCreate, ownerView);
  // Ownership-scoped create does not disturb the owner's resolution.
  const ownerAgain = await repository.findIdempotentResolution({
    userId: 10,
    idempotencyKey: "shared-key",
    requestFingerprint: FINGERPRINT_AB,
  });
  assert.equal((ownerAgain as { paymentId: string }).paymentId, "payment-owner");
  assert.ok(!JSON.stringify(ownerAgain).includes("payment-foreign"));
  assert.ok(!JSON.stringify(ownerAgain).includes("attempt-foreign"));
});

test("ownership rule: a foreign owner sees the record as not-found, never as a conflict", async () => {
  const repository = new InMemoryIdempotencyRepository();
  await repository.createIdempotentResolution({
    userId: 10,
    idempotencyKey: "key-owner",
    requestFingerprint: FINGERPRINT_CD,
    paymentId: "payment-owner",
    attemptId: "attempt-owner",
  });
  const foreignView = await repository.findIdempotentResolution({
    userId: 99,
    idempotencyKey: "key-owner",
    requestFingerprint: FINGERPRINT_AB, // even with a differing fingerprint
  });
  assert.equal(foreignView, undefined, "foreign lookup must be invisible, not CONFLICT");
});

// Structural probe: the fakes above satisfy the repository port for the
// idempotency methods they model.
const repositoryPortProbe: Pick<
  PaymentRepositoryPort,
  "findIdempotentResolution" | "createIdempotentResolution"
> = new InMemoryIdempotencyRepository();
assert.ok(repositoryPortProbe.findIdempotentResolution({ userId: 1, idempotencyKey: "k", requestFingerprint: FINGERPRINT_AB }) instanceof Promise);
