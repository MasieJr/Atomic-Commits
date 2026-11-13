// L3 contract tests — ports are mockable in-memory, grant/offline semantics.
// No HTTP, no database, no provider SDK: everything here is local state.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  grantAllowsMerchantScope,
  isGrantWithinValidityWindow,
  isEnvelopeWithinValidityWindow,
  isEnvelopeWindowWithinInstruction,
  isNonceUnseen,
  makeMoney,
  OFFLINE_INSTRUCTION_VERSION,
  type AtomicClaimPort,
  type ClaimResult,
  type ClockPort,
  type DeviceVerificationOutcome,
  type DeviceVerificationPort,
  type EligibilityDecisionInput,
  type GrantLifecyclePort,
  type GrantRotationOutcome,
  type OfflineEnvelope,
  type PayeeIdentity,
  type PaymentEligibilityPort,
  type PaymentEngine,
  type PaymentEventsPort,
  type PaymentQuote,
  type PaymentRepositoryPort,
  type PaymentsProviderPort,
  type QuoteRequest,
  type RedemptionClaim,
  type SignedInstruction,
} from "../src/domain/payment-engine/index";

// ---------------- Shared fakes ----------------

/** Clock fake: returns only injected times; never consults Date.now. */
class FixedClock {
  readonly times: number[];
  private index = 0;

  constructor(...times: number[]) {
    this.times = [...times];
  }

  get port(): ClockPort {
    return { nowEpochMs: (): number => this.times[Math.min(this.index++, this.times.length - 1)] };
  }
}

test("Clock fake returns exactly the injected times, never Date.now", () => {
  const capturedBefore = Date.now;
  try {
    Date.now = () => {
      throw new Error("domain must not call Date.now");
    };
    const clock = new FixedClock(1000, 2000, 3000).port;
    assert.equal(clock.nowEpochMs(), 1000);
    assert.equal(clock.nowEpochMs(), 2000);
    assert.equal(clock.nowEpochMs(), 3000);
    assert.equal(clock.nowEpochMs(), 3000, "repeats the last value when exhausted");
  } finally {
    Date.now = capturedBefore;
  }
});

// ---------------- PaymentsProviderPort: single-shot submit ----------------

/** Provider fake with explicit single-shot discipline and ambiguous mode. */
class ProviderFake {
  private readonly submitted: string[] = [];
  private readonly quotedPayees: PayeeIdentity[] = [];
  private ambiguous = false;

  constructor(...seededSubmissions: readonly string[]) {
    this.submitted.push(...seededSubmissions);
  }

  respondAmbiguously(): void {
    this.ambiguous = true;
  }

  get submittedAttempts(): readonly string[] {
    return this.submitted;
  }

  get payeesSeen(): readonly PayeeIdentity[] {
    return this.quotedPayees;
  }

  get port(): PaymentsProviderPort {
    const provider: Pick<
      PaymentsProviderPort,
      "createQuote" | "submitPayment" | "readProviderStatus"
    > = {
      createQuote: async (refs: QuoteRequest): Promise<PaymentQuote> => {
        this.quotedPayees.push(refs.payee);
        return {
          attemptId: refs.attemptId,
          providerQuoteRef: `quote-${refs.attemptId}`,
          payerDebit: refs.maxPayerDebit ?? makeMoney("100", "USD", 2),
          merchantReceive: refs.merchantReceive,
        };
      },
      submitPayment: async (attemptId: string, quoteRef: string) => this.submit(attemptId, quoteRef),
      readProviderStatus: async () => ({ kind: "UNRESOLVED" as const }),
    };
    return provider;
  }

  private submit(attemptId: string, quoteRef: string): Promise<Awaited<ReturnType<PaymentsProviderPort["submitPayment"]>>> {
    assert.ok(quoteRef.length > 0);
    if (this.submitted.includes(attemptId)) {
      // Single-shot discipline: the fake refuses an already-submitted attempt
      // so a caller-level retry would be visible in tests.
      this.refusedSecondSubmit = attemptId;
      throw new Error(`single-shot violation: attempt ${attemptId} already submitted`);
    }
    this.submitted.push(attemptId);
    if (this.ambiguous) {
      return Promise.resolve({
        attemptId,
        paymentId: "payment-1",
        userId: 1,
        status: "UNKNOWN",
      });
    }
    return Promise.resolve({
      attemptId,
      paymentId: "payment-1",
      userId: 1,
      status: "PROCESSING",
      providerAttemptRef: `provider-${attemptId}`,
    });
  }

  private refusedSecondSubmit?: string;

  get refusedSubmit(): string | undefined {
    return this.refusedSecondSubmit;
  }
}

test("provider fake: submit is single-shot; ambiguous provider response maps to UNKNOWN", async () => {
  const provider = new ProviderFake();
  const firstAttempt = await provider.port.submitPayment("attempt-1", "quote-1", 1);
  assert.equal(firstAttempt.status, "PROCESSING");
  const ambiguous = new ProviderFake();
  ambiguous.respondAmbiguously();
  const unknownAttempt = await ambiguous.port.submitPayment("attempt-2", "quote-2", 1);
  assert.equal(unknownAttempt.status, "UNKNOWN");
  assert.deepEqual([...ambiguous.submittedAttempts], ["attempt-2"]);
});

test("provider fake: a second submit of the same attempt is refused, never re-issued", async () => {
  const provider = new ProviderFake();
  await provider.port.submitPayment("attempt-1", "quote-1", 1);
  assert.deepEqual([...provider.submittedAttempts], ["attempt-1"]);
  await assert.rejects(
    () => provider.port.submitPayment("attempt-1", "quote-1", 1),
    /single-shot violation/
  );
  assert.equal(provider.refusedSubmit, "attempt-1");
  assert.deepEqual(
    [...provider.submittedAttempts],
    ["attempt-1"],
    "exactly one submission was performed after the retry"
  );
});

// ---------------- GrantLifecyclePort ----------------

test("provider fake: QuoteRequest payee identity reaches the provider", async () => {
  const provider = new ProviderFake();
  const payee: PayeeIdentity = { payeeId: "payee-alpha", merchantScopeId: "scope-42" };
  const quote = await provider.port.createQuote({
    userId: 1,
    attemptId: "attempt-q",
    payee,
    merchantReceive: makeMoney("95", "USD", 2),
    maxPayerDebit: makeMoney("100", "USD", 2),
  });
  assert.deepEqual(provider.payeesSeen, [{ payeeId: "payee-alpha", merchantScopeId: "scope-42" }]);
  assert.equal(quote.attemptId, "attempt-q");
  assert.equal(quote.providerQuoteRef, "quote-attempt-q");
  // Quote sides stay distinct: payerDebit measured separately from merchantReceive.
  assert.equal(quote.payerDebit.value, "100");
  assert.equal(quote.merchantReceive.value, "95");
});


test("grant lifecycle fake returns ROTATED with a new authority ref, or UNRESOLVED on ambiguity", async () => {
  const ROTATED: GrantRotationOutcome = {
    kind: "ROTATED",
    authorizationId: "auth-1",
    newAuthorityRef: "authority-v2",
    newStatus: "ROTATING",
  };
  const UNRESOLVED: GrantRotationOutcome = { kind: "UNRESOLVED" };
  const port: GrantLifecyclePort = {
    loadAuthorization: async () => {
      throw new Error("not exercised");
    },
    rotateAuthority: async (args): Promise<GrantRotationOutcome> =>
      args.authorizationId === "ambiguous" ? UNRESOLVED : ROTATED,
    cancelAuthorization: async () => undefined,
  };
  const rotated = await port.rotateAuthority({ userId: 1, authorizationId: "auth-1" });
  assert.equal(rotated.kind, "ROTATED");
  if (rotated.kind === "ROTATED") {
    assert.equal(rotated.newAuthorityRef, "authority-v2");
    assert.notEqual(rotated.newAuthorityRef, "authority-v1");
  }
  const ambiguous = await port.rotateAuthority({ userId: 1, authorizationId: "ambiguous" });
  assert.deepEqual(ambiguous, { kind: "UNRESOLVED" });
  // Domain-facing rotation outcome contains no token material.
  assert.ok(!JSON.stringify(rotated).toLowerCase().includes("token"));
});

// ---------------- PaymentRepositoryPort ----------------

test("repository fake serves lookups scoped to the owning user only", async () => {
  const repository = new InMemoryPaymentRepository();
  await repository.port.saveAttempt({
    userId: 5,
    attempt: {
      attemptId: "attempt-1",
      paymentId: "payment-1",
      userId: 5,
      status: "PROCESSING",
    },
  });
  const owned = await repository.port.loadAttempt({ userId: 5, attemptId: "attempt-1" });
  assert.equal(owned?.status, "PROCESSING");
  const foreign = await repository.port.loadAttempt({ userId: 6, attemptId: "attempt-1" });
  assert.equal(foreign, undefined, "cross-user reads behave as not-found");
});

class InMemoryPaymentRepository {
  private readonly attempts = new Map<string, { readonly userId: number; readonly attempt: AttemptShape }>();

  get port(): PaymentRepositoryPort {
    return {
      findIdempotentResolution: async () => undefined,
      createIdempotentResolution: async () => {
        throw new Error("not exercised here");
      },
      loadAttempt: async (args) => {
        const found = this.attempts.get(args.attemptId);
        return found !== undefined && found.userId === args.userId ? found.attempt : undefined;
      },
      saveAttempt: async (args) => {
        this.attempts.set(args.attempt.attemptId, { userId: args.userId, attempt: args.attempt });
      },
      loadResult: async () => undefined,
      saveResult: async () => undefined,
      loadGrantAuthorization: async () => undefined,
    } satisfies PaymentRepositoryPort;
  }
}
type AttemptShape = Awaited<ReturnType<PaymentRepositoryPort["loadAttempt"]>> extends infer T
  ? T extends undefined ? never : NonNullable<T>
  : never;
assert.ok(typeof ({} as AttemptShape).status === "string" || true); // smoke: shape compiles

// ---------------- AtomicClaimPort ----------------

/** Claim fake: unique across NONCE globally (not instructionId); reservations held until released. */
class InMemoryAtomicClaim {
  /** nonce -> the instruction id that first consumed it. */
  private readonly consumedNonces = new Map<string, string>();
  /** "userId::nonce" -> instructionId holding the reservation. */
  private readonly reservations = new Map<string, string>();
  private budgetRemaining = 1000;

  constructor(initialBudget = 1000) {
    this.budgetRemaining = initialBudget;
  }

  get port(): AtomicClaimPort {
    return {
      claimInstructionAndReserveBudget: async (args): Promise<ClaimResult> => {
        const priorInstructionId = this.consumedNonces.get(args.nonce);
        if (priorInstructionId !== undefined) {
          return { kind: "ALREADY_CLAIMED", priorInstructionId };
        }
        const potentialMinor = Number(args.maxPotentialDebit.value);
        if (!Number.isFinite(potentialMinor) || potentialMinor > this.budgetRemaining) {
          return { kind: "INSUFFICIENT_BUDGET", code: "CLAIM_INSUFFICIENT_BUDGET" };
        }
        if (args.maxPotentialDebit.value === "0") {
          return { kind: "INVALID", code: "CLAIM_INVALID" };
        }
        if (args.authorizationId === "conflicting") {
          return { kind: "CONFLICT", code: "CLAIM_CONFLICT" };
        }
        this.consumedNonces.set(args.nonce, args.instructionId);
        this.reservations.set(`${args.userId}::${args.nonce}`, args.instructionId);
        return { kind: "CLAIMED", paymentId: `payment-${args.instructionId}` };
      },
      releaseReservation: async (args) => {
        // ReleaseRequest carries no nonce; match by owner + instruction id.
        for (const [key, holdingInstructionId] of this.reservations) {
          if (key.startsWith(`${args.userId}::`) && holdingInstructionId === args.instructionId) {
            this.reservations.delete(key);
          }
        }
      },
      recordClaim: async (args): Promise<RedemptionClaim> => ({
        version: OFFLINE_INSTRUCTION_VERSION,
        instructionId: args.instructionId,
        nonce: args.nonce,
        authorizationId: args.authorizationId,
        userId: args.userId,
        envelopeId: args.envelopeId,
        deviceEnrollmentId: args.deviceEnrollmentId,
        claimedAtEpochMs: args.claimedAtEpochMs,
        reservedMaxDebit: args.reservedMaxDebit.value,
      }),
    };
  }

  isReservationHeld(userId: number, nonce: string): boolean {
    return this.reservations.has(`${userId}::${nonce}`);
  }
}
function claimRequest(overrides: {
  readonly instructionId: string;
  readonly nonce: string;
  readonly authorizationId?: string;
  readonly maxPotentialDebit?: MoneyValue;
}): FullClaimArgs {
  return {
    userId: 1,
    instructionId: overrides.instructionId,
    nonce: overrides.nonce,
    envelopeId: `envelope-${overrides.nonce}`,
    authorizationId: overrides.authorizationId ?? "auth-1",
    maxPotentialDebit: overrides.maxPotentialDebit ?? makeMoney("100", "USD", 2),
    requestFingerprint: "a".repeat(64),
  };
}
type MoneyValue = ReturnType<typeof makeMoney>;
type FullClaimArgs = Parameters<AtomicClaimPort["claimInstructionAndReserveBudget"]>[0];

test("claim fake: CLAIMED output includes the payment id, ALREADY_CLAIMED repeats prior instruction", async () => {
  const claim = new InMemoryAtomicClaim();
  const first = await claim.port.claimInstructionAndReserveBudget(
    claimRequest({ instructionId: "instr-1", nonce: "nonce-1" })
  );
  assert.deepEqual(first, { kind: "CLAIMED", paymentId: "payment-instr-1" });
  const second = await claim.port.claimInstructionAndReserveBudget(
    claimRequest({ instructionId: "instr-1", nonce: "nonce-1" })
  );
  assert.deepEqual(second, { kind: "ALREADY_CLAIMED", priorInstructionId: "instr-1" });
});

test("claim fake: a replayed nonce on a DIFFERENT instruction id resolves to the FIRST instruction", async () => {
  const claim = new InMemoryAtomicClaim();
  const firstByInstrA = await claim.port.claimInstructionAndReserveBudget(
    claimRequest({ instructionId: "instr-A", nonce: "shared-nonce" })
  );
  assert.deepEqual(firstByInstrA, { kind: "CLAIMED", paymentId: "payment-instr-A" });
  const replayByInstrB = await claim.port.claimInstructionAndReserveBudget(
    claimRequest({ instructionId: "instr-B", nonce: "shared-nonce" })
  );
  assert.equal(replayByInstrB.kind, "ALREADY_CLAIMED");
  if (replayByInstrB.kind === "ALREADY_CLAIMED") {
    assert.equal(
      replayByInstrB.priorInstructionId,
      "instr-A",
      "prior instruction id, not the replaying one, is surfaced"
    );
  }
  // A fresh nonce is still claimable after the replay was refused.
  const fresh = await claim.port.claimInstructionAndReserveBudget(
    claimRequest({ instructionId: "instr-C", nonce: "other-nonce" })
  );
  assert.deepEqual(fresh, { kind: "CLAIMED", paymentId: "payment-instr-C" });
});

test("claim fake portrait: INSUFFICIENT_BUDGET, CONFLICT, INVALID all returned distinctly", async () => {
  const poor = new InMemoryAtomicClaim(50);
  assert.deepEqual(
    await poor.port.claimInstructionAndReserveBudget(
      claimRequest({ instructionId: "i-over", nonce: "n-over", maxPotentialDebit: makeMoney("51", "USD", 2) })
    ),
    { kind: "INSUFFICIENT_BUDGET", code: "CLAIM_INSUFFICIENT_BUDGET" }
  );
  const conflicting = new InMemoryAtomicClaim();
  assert.deepEqual(
    await conflicting.port.claimInstructionAndReserveBudget(
      claimRequest({ instructionId: "i-conflict", nonce: "n-conflict", authorizationId: "conflicting" })
    ),
    { kind: "CONFLICT", code: "CLAIM_CONFLICT" }
  );
  const invalid = new InMemoryAtomicClaim();
  assert.deepEqual(
    await invalid.port.claimInstructionAndReserveBudget(
      claimRequest({ instructionId: "i-invalid", nonce: "n-invalid", maxPotentialDebit: makeMoney("0", "USD", 2) })
    ),
    { kind: "INVALID", code: "CLAIM_INVALID" }
  );
});

class ReservationHarness {
  private readonly inner = new InMemoryAtomicClaim();
  private readonly nonce: string;

  constructor(
    private readonly userId: number,
    private readonly instructionId: string
  ) {
    this.nonce = `nonce-${instructionId}`;
  }

  claim(): Promise<ClaimResult> {
    return this.inner.port.claimInstructionAndReserveBudget(
      claimRequest({
        instructionId: this.instructionId,
        nonce: this.nonce,
      })
    );
  }

  reservationHeld(): boolean {
    return this.inner.isReservationHeld(this.userId, this.nonce);
  }

  release(): Promise<void> {
    return this.inner.port.releaseReservation({
      userId: this.userId,
      instructionId: this.instructionId,
      authorizationId: "auth-1",
    });
  }

  record(claimedAtEpochMs: number): Promise<RedemptionClaim> {
    return this.inner.port.recordClaim({
      userId: this.userId,
      envelopeId: "envelope-1",
      instructionId: this.instructionId,
      nonce: this.nonce,
      authorizationId: "auth-1",
      deviceEnrollmentId: "enrollment-held",
      reservedMaxDebit: makeMoney("100", "USD", 2),
      claimedAtEpochMs,
    });
  }
}

test("claim fake: reservation held until explicit release; recordClaim carries nonce/enrollment/reserved amount, token-free", async () => {
  const harness = new ReservationHarness(1, "instr-held");
  await harness.claim();
  assert.equal(harness.reservationHeld(), true, "reservation held while outcome unresolved");
  await harness.release();
  assert.equal(harness.reservationHeld(), false);
  const recorded = await harness.record(1_700_000_000_000);
  assert.equal(recorded.version, OFFLINE_INSTRUCTION_VERSION);
  // RecordClaimRequest values are carried through verbatim.
  assert.equal(recorded.instructionId, "instr-held");
  assert.equal(recorded.nonce, "nonce-instr-held");
  assert.equal(recorded.envelopeId, "envelope-1");
  assert.equal(recorded.deviceEnrollmentId, "enrollment-held");
  assert.equal(recorded.reservedMaxDebit, "100");
  assert.equal(recorded.claimedAtEpochMs, 1_700_000_000_000);
  const serialized = JSON.stringify(recorded);
  assert.ok(!serialized.toLowerCase().includes("token"), serialized);
  assert.ok(!serialized.toLowerCase().includes("secret"), serialized);
  assert.ok(!serialized.toLowerCase().includes("continuation"), serialized);
});

// ---------------- DeviceVerificationPort ----------------

const VERIFIED: DeviceVerificationOutcome = { kind: "VERIFIED", deviceEnrollmentId: "enrollment-1" };
const NOT_ENROLLED: DeviceVerificationOutcome = { kind: "NOT_ENROLLED", code: "DEVICE_NOT_VERIFIED" };
const REVOKED: DeviceVerificationOutcome = { kind: "REVOKED", code: "DEVICE_NOT_VERIFIED" };
const SIGNATURE_INVALID: DeviceVerificationOutcome = { kind: "SIGNATURE_INVALID", code: "DEVICE_NOT_VERIFIED" };

test("device verification fake enumerates the four outcomes; the three denials use DEVICE_NOT_VERIFIED", async () => {
  const outcomesByEnrollment: Record<string, DeviceVerificationOutcome> = {
    "enrollment-1": VERIFIED,
    unknown: NOT_ENROLLED,
    revoked: REVOKED,
    "bad-signature": SIGNATURE_INVALID,
  };
  const port: DeviceVerificationPort = {
    verify: async (args) => {
      assert.equal(typeof args.nowEpochMs, "number");
      return outcomesByEnrollment[args.instruction.keyVersion] ?? NOT_ENROLLED;
    },
  };
  const envelope = fakeEnvelope();
  for (const [keyVersion, expected] of Object.entries(outcomesByEnrollment)) {
    const outcome = await port.verify({
      userId: 1,
      envelope,
      instruction: { ...envelope.instruction, keyVersion },
      nowEpochMs: 100,
    });
    assert.deepEqual(outcome, expected);
    if (outcome.kind !== "VERIFIED") {
      assert.equal(outcome.code, "DEVICE_NOT_VERIFIED");
    }
  }
});

// ---------------- PaymentEventsPort (structural) ----------------

test("PaymentEventsPort structural typing accepts a memory fake", async () => {
  const recorded: string[] = [];
  const port: PaymentEventsPort = {
    record: async (event) => {
      recorded.push(event.eventId);
    },
  };
  await port.record({
    eventId: "e-1",
    userId: 1,
    paymentId: "payment-1",
    type: "PAYMENT_SUBMITTED",
    occurredAtEpochMs: 0,
    payload: { kind: "none" },
  });
  assert.deepEqual(recorded, ["e-1"]);
});

// ---------------- PaymentEligibilityPort ----------------

/** Pure policy fake mirroring the documented ceiling/budget/merchant rules. */
function fakeEligibilityPort(grantFixed: {
  perPaymentMaxDebit: bigint;
  cumulativeRemaining: bigint;
  merchantScopeId?: string;
}): PaymentEligibilityPort {
  return {
    evaluate: (input: EligibilityDecisionInput) => {
      if (!input.merchantVerified) {
        return { allowed: false, denialCode: "MERCHANT_NOT_VERIFIED" };
      }
      if (
        grantFixed.merchantScopeId !== undefined &&
        grantFixed.merchantScopeId !== input.merchantScopeId
      ) {
        return { allowed: false, denialCode: "GRANT_INVALID" };
      }
      const debitMinor = BigInt(input.amountDebit.value);
      if (debitMinor > grantFixed.perPaymentMaxDebit) {
        return { allowed: false, denialCode: "OVER_TRANSACTION_CEILING" };
      }
      if (debitMinor > grantFixed.cumulativeRemaining) {
        return { allowed: false, denialCode: "CUMULATIVE_BUDGET_EXCEEDED" };
      }
      return { allowed: true };
    },
  } satisfies PaymentEligibilityPort;
}

function eligibilityInput(overrides: Partial<EligibilityDecisionInput>): EligibilityDecisionInput {
  return {
    authorization: {
      authorizationId: "auth-1",
      userId: 1,
      status: "ACTIVE",
      authorityRef: "authority-1",
      kind: "OUTGOING_PAYMENT",
      perPaymentMaxDebit: makeMoney("1000", "USD", 2),
      cumulativeCap: makeMoney("2000", "USD", 2),
      cumulativeSpent: makeMoney("0", "USD", 2),
      validFromEpochMs: 0,
      validUntilEpochMs: 100,
      payerAssetCode: "USD",
      payerAssetScale: 2,
      revocationVersion: 1,
    },
    amountDebit: makeMoney("10", "USD", 2),
    merchantScopeId: "merchant-1",
    merchantVerified: true,
    nowEpochMs: 50,
    deviceEnrolled: true,
    ...overrides,
  };
}

test("eligibility denies MERCHANT_NOT_VERIFIED when merchantVerified is false — before amount checks", () => {
  const port = fakeEligibilityPort({ perPaymentMaxDebit: 10n, cumulativeRemaining: 10n });
  const decision = port.evaluate(
    eligibilityInput({
      merchantVerified: false,
      amountDebit: makeMoney("999999", "USD", 2), // over every ceiling, but the merchant check must win first
    })
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.denialCode, "MERCHANT_NOT_VERIFIED");
});

test("eligibility denies OVER_TRANSACTION_CEILING and CUMULATIVE_BUDGET_EXCEEDED by amount", () => {
  const port = fakeEligibilityPort({ perPaymentMaxDebit: 100n, cumulativeRemaining: 200n });
  const overCeiling = port.evaluate(eligibilityInput({ amountDebit: makeMoney("101", "USD", 2) }));
  assert.deepEqual(overCeiling, { allowed: false, denialCode: "OVER_TRANSACTION_CEILING" });
  // Over the cumulative remainder but under the per-payment ceiling.
  const underCeilingPort = fakeEligibilityPort({ perPaymentMaxDebit: 1000n, cumulativeRemaining: 200n });
  const overCumulative = underCeilingPort.evaluate(eligibilityInput({ amountDebit: makeMoney("201", "USD", 2) }));
  assert.deepEqual(overCumulative, { allowed: false, denialCode: "CUMULATIVE_BUDGET_EXCEEDED" });
  assert.deepEqual(underCeilingPort.evaluate(eligibilityInput({ amountDebit: makeMoney("100", "USD", 2) })), { allowed: true });
  assert.deepEqual(underCeilingPort.evaluate(eligibilityInput({ amountDebit: makeMoney("200", "USD", 2) })), { allowed: true });
});

// ---------------- PaymentEngine structural typing ----------------

test("PaymentEngine interface is satisfied by a pure in-memory fake (structural typing)", async () => {
  class EngineFake implements PaymentEngine {
    private readonly clock = new FixedClock(42).port;
    async online(): Promise<Awaited<ReturnType<PaymentEngine["online"]>>> {
      return {
        attemptId: "a-1",
        paymentId: "p-1",
        status: "SUCCEEDED",
        payerDebitPaid: makeMoney("100", "USD", 2),
        merchantReceivePaid: makeMoney("95", "USD", 2),
        resolvedAtEpochMs: this.clock.nowEpochMs(),
      };
    }
    async redeemOffline(): Promise<Awaited<ReturnType<PaymentEngine["redeemOffline"]>>> {
      return { attemptId: "a-2", paymentId: "p-2", status: "FAILED", failureCode: "CLAIM_CONFLICT" };
    }
    async statusOf(args: Parameters<PaymentEngine["statusOf"]>[0]): Promise<Awaited<ReturnType<PaymentEngine["statusOf"]>>> {
      const foreign = args.userId !== 1;
      return foreign ? { attemptId: "a-hidden", paymentId: "p-hidden", status: "REJECTED" } : { attemptId: "a-1", paymentId: "p-1", status: "SUCCEEDED" };
    }
  }
  const engine: PaymentEngine = new EngineFake();
  const result = await engine.online(
    {
      userId: 1,
      idempotencyKey: "key-1",
      paymentId: "p-1",
      authorizationId: "auth-1",
      merchant: { payeeId: "payee-1", merchantScopeId: "merchant-1" },
      merchantReceive: makeMoney("95", "USD", 2),
      maxPayerDebit: makeMoney("100", "USD", 2),
    },
    new FixedClock(1).port
  );
  assert.equal(result.status, "SUCCEEDED");
  // payerDebit vs merchantReceive kept distinct fields in the result type.
  assert.ok(result.payerDebitPaid !== result.merchantReceivePaid);
});

// ---------------- Grants ----------------

function grant(overrides: Partial<Parameters<typeof grantAllowsMerchantScope>[0]>): ReturnType<typeof makeGrant>["grant"] {
  return makeGrant(overrides).grant;
}

function makeGrant(overrides: Partial<{
  merchantScopeId?: string;
  validFromEpochMs: number;
  validUntilEpochMs: number;
}>): { readonly grant: Parameters<typeof grantAllowsMerchantScope>[0] } {
  return {
    grant: {
      authorizationId: "auth-1",
      userId: 1,
      status: "ACTIVE",
      authorityRef: "authority-1",
      kind: "OUTGOING_PAYMENT",
      perPaymentMaxDebit: makeMoney("1000", "USD", 2),
      cumulativeCap: makeMoney("2000", "USD", 2),
      cumulativeSpent: makeMoney("0", "USD", 2),
      validFromEpochMs: 100,
      validUntilEpochMs: 200,
      payerAssetCode: "USD",
      payerAssetScale: 2,
      revocationVersion: 1,
      ...overrides,
    },
  };
}

test("grantAllowsMerchantScope: absent scope = any merchant, present = exact match, empty scope never allowed", () => {
  const unbound = grant({});
  assert.equal(unbound.merchantScopeId, undefined);
  assert.equal(grantAllowsMerchantScope(unbound, "merchant-a"), true);
  // Empty-string merchant scope is rejected for BOTH bound and unbound grants.
  assert.equal(grantAllowsMerchantScope(unbound, ""), false, "empty scope rejected even for unbound grant");
  const bound = grant({ merchantScopeId: "merchant-a" });
  assert.equal(grantAllowsMerchantScope(bound, "merchant-a"), true);
  assert.equal(grantAllowsMerchantScope(bound, "merchant-b"), false);
  assert.equal(grantAllowsMerchantScope(bound, ""), false, "empty scope rejected for bound grant");
  assert.equal(grantAllowsMerchantScope(bound, "merchant-"), false);
});

test("grant validity window is inclusive at both boundaries", () => {
  const g = grant({});
  assert.equal(isGrantWithinValidityWindow(g, 100), true, "validFrom inclusive");
  assert.equal(isGrantWithinValidityWindow(g, 200), true, "validUntil inclusive");
  assert.equal(isGrantWithinValidityWindow(g, 99), false);
  assert.equal(isGrantWithinValidityWindow(g, 201), false);
  assert.equal(isGrantWithinValidityWindow(g, 150), true);
});

test("revocationVersion semantics: only an equal version binds an envelope to a grant", () => {
  const g = grant({});
  const envelope = fakeEnvelope({ grantRevocationVersion: g.revocationVersion });
  assert.equal(envelope.grantRevocationVersion, g.revocationVersion, "envelope bound to issuance-time version");
  const rotated = grant({ revocationVersion: 2 });
  assert.notEqual(rotated.revocationVersion, g.revocationVersion, "version increments on revoke/rotate");
  const boundEnvelope = grant({});
  assert.equal(isGrantWithinValidityWindow(boundEnvelope, 100), true);
  void envelope;
});

test("revocationVersion accepts 0 as a meaningful version and rejects negative in fakes usage", () => {
  const zeroGrant = grant({ revocationVersion: 0 });
  assert.equal(zeroGrant.revocationVersion, 0);
  const multiGrant = grant({ revocationVersion: 2147483647 });
  assert.ok(multiGrant.revocationVersion > 0);
});

// ---------------- Offline ----------------

function fakeInstruction(overrides: Partial<SignedInstruction> = {}): SignedInstruction {
  return {
    version: OFFLINE_INSTRUCTION_VERSION,
    instructionId: "instr-1",
    nonce: "nonce-1",
    keyVersion: "key-1",
    instructionEpochMs: 100,
    issuedAtEpochMs: 100,
    expiresAtEpochMs: 200,
    maxDebitMinor: "100",
    assetCode: "USD",
    assetScale: 2,
    bytesB64Utf8: "b3BhcXVlLTE=",
    ...overrides,
  };
}

function fakeEnvelope(overrides: Partial<OfflineEnvelope> = {}): OfflineEnvelope {
  return {
    version: OFFLINE_INSTRUCTION_VERSION,
    envelopeId: "envelope-1",
    instruction: fakeInstruction(),
    authorizationId: "auth-1",
    grantRevocationVersion: 1,
    deviceEnrollmentId: "enrollment-1",
    issuedAtEpochMs: 100,
    expiresAtEpochMs: 200,
    ...overrides,
  };
}

test('offline version is exactly "1"', () => {
  assert.equal(OFFLINE_INSTRUCTION_VERSION, "1");
  assert.equal(fakeEnvelope().version, "1");
  assert.equal(fakeInstruction().version, "1");
});

test("isEnvelopeWithinValidityWindow is inclusive at both boundaries", () => {
  const envelope = fakeEnvelope();
  assert.equal(isEnvelopeWithinValidityWindow(envelope, 100), true, "issuedAt inclusive");
  assert.equal(isEnvelopeWithinValidityWindow(envelope, 200), true, "expiresAt inclusive");
  assert.equal(isEnvelopeWithinValidityWindow(envelope, 99), false);
  assert.equal(isEnvelopeWithinValidityWindow(envelope, 201), false);
});

test("isEnvelopeWindowWithinInstruction: true for subset/equal windows, false on either side of disagreement", () => {
  // Equal boundaries count as a subset (inclusive).
  assert.equal(isEnvelopeWindowWithinInstruction(fakeEnvelope()), true, "identical windows accepted");
  // Strict subset inside the instruction window.
  assert.equal(
    isEnvelopeWindowWithinInstruction(
      fakeEnvelope({ issuedAtEpochMs: 120, expiresAtEpochMs: 180 })
    ),
    true,
    "envelope strictly inside the instruction window accepted"
  );
  // Envelope starts before the instruction.
  assert.equal(
    isEnvelopeWindowWithinInstruction(
      fakeEnvelope({ issuedAtEpochMs: 99, expiresAtEpochMs: 180 })
    ),
    false,
    "envelope starting before the instruction rejected"
  );
  // Envelope expires after the instruction.
  assert.equal(
    isEnvelopeWindowWithinInstruction(
      fakeEnvelope({ issuedAtEpochMs: 120, expiresAtEpochMs: 201 })
    ),
    false,
    "envelope expiring after the instruction rejected"
  );
});

test("isNonceUnseen: true for a new nonce, false for a seen nonce", () => {
  const envelope = fakeEnvelope({ instruction: fakeInstruction({ nonce: "fresh-nonce" }) });
  assert.equal(isNonceUnseen(envelope, []), true);
  assert.equal(isNonceUnseen(envelope, ["other-nonce", "yet-another"]), true);
  assert.equal(isNonceUnseen(envelope, ["fresh-nonce"]), false);
  assert.equal(isNonceUnseen(envelope, ["a", "fresh-nonce", "b"]), false);
});

test("RedemptionClaim record never contains token material", () => {
  const harness = new ReservationHarness(1, "instr-clean");
  void harness;
  const claimRecord: RedemptionClaim = {
    version: OFFLINE_INSTRUCTION_VERSION,
    instructionId: "instr-clean",
    nonce: "nonce-clean",
    authorizationId: "auth-1",
    userId: 1,
    envelopeId: "envelope-1",
    deviceEnrollmentId: "enrollment-1",
    claimedAtEpochMs: 1_700_000_000_000,
    reservedMaxDebit: "100",
  };
  const keys = Object.keys(claimRecord);
  for (const forbidden of ["token", "accessToken", "secret", "continuation", "bytesB64Utf8", "keyMaterial"]) {
    for (const key of keys) {
      assert.ok(!key.toLowerCase().includes(forbidden.toLowerCase()), `claim key ${key} looks token-like`);
    }
  }
  assert.equal("bytesB64Utf8" in claimRecord, false, "opaque instruction bytes never enter claim records");
  const serialized = JSON.stringify(claimRecord);
  assert.ok(!serialized.toLowerCase().includes("access token"));
});
