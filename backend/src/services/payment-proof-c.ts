import {
  GrantLifecycleError,
  type GrantCounterFailureReason,
  type FreshGrantCounterObservation,
  type OutgoingGrantAuthority,
  type OutgoingGrantLifecycle,
  type RotationCounterObservation,
  type ValidatedSpentCounter,
} from "./grant-lifecycle";
import type { ApprovedSpending, PaymentProofs, PreparedPayment } from "./payment-proof";
import type { WalletAddress } from "@interledger/open-payments";
import { minorValue, sameAsset, type Amount, type PaymentEvidence } from "./payment-proof-run";

// the property under test: a consented payer allowance stays usable at least 25 minutes
// after approval, across provider-required token rotations, with an unbroken counter.
export const PROOF_C_OBSERVATION_MS = 25 * 60 * 1000;

export type ProofCStatus = "NOT_RUN" | "PASSED" | "FAILED" | "INCONCLUSIVE";

export interface ProofCConfig {
  aggregateBudget: Amount;
  perPaymentMaxDebit: Amount;
  receiveAmount: Amount;
  // dev operational slack, not spending policy
  rotationEarlyMarginMs: number;
  // bounded read-only counter catch-up window after each confirmed payment
  counterSettleMs: number;
  counterPollIntervalMs: number;
}

// only these names carry money; never a hardcoded/defaulted amount
const REQUIRED_MONEY_ENV = [
  "PAYMENT_PROOF_BUDGET_MINOR",
  "PAYMENT_PROOF_C_MAX_DEBIT_MINOR",
  "PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR",
  "PAYMENT_PROOF_C_PAYER_ASSET_CODE",
  "PAYMENT_PROOF_C_PAYER_ASSET_SCALE",
  "PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE",
  "PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE",
] as const;

export class ProofCConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofCConfigError";
  }
}

// explicit money configuration; no product/default spending policy lives here
export function readProofCConfig(env: Record<string, string | undefined>): ProofCConfig {
  const missing = REQUIRED_MONEY_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ProofCConfigError(`Proof C requires explicit money settings with no defaults; set: ${missing.join(", ")}.`);
  }
  let budgetMinor: bigint;
  let maxDebitMinor: bigint;
  let receiveMinor: bigint;
  try {
    budgetMinor = minorValue(env.PAYMENT_PROOF_BUDGET_MINOR!.trim());
    maxDebitMinor = minorValue(env.PAYMENT_PROOF_C_MAX_DEBIT_MINOR!.trim());
    receiveMinor = minorValue(env.PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR!.trim());
  } catch {
    throw new ProofCConfigError("Proof C amounts must be positive integer minor-unit strings.");
  }
  if (budgetMinor === 0n || maxDebitMinor === 0n || receiveMinor === 0n) {
    throw new ProofCConfigError("Proof C amounts must be positive.");
  }
  const payerAsset = requiredAsset(env.PAYMENT_PROOF_C_PAYER_ASSET_CODE!.trim(), env.PAYMENT_PROOF_C_PAYER_ASSET_SCALE!.trim(), "payer");
  const recipientAsset = requiredAsset(env.PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE!.trim(), env.PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE!.trim(), "recipient");
  const aggregateBudget: Amount = { ...payerAsset, value: budgetMinor.toString() };
  const perPaymentMaxDebit: Amount = { ...payerAsset, value: maxDebitMinor.toString() };
  if (maxDebitMinor > budgetMinor) {
    throw new ProofCConfigError("The per-payment payer debit ceiling must not exceed the aggregate grant budget.");
  }
  return {
    aggregateBudget,
    perPaymentMaxDebit,
    receiveAmount: { ...recipientAsset, value: receiveMinor.toString() },
    // defaults below are dev operational slack (rotation starts 60s before a deadline;
    // counter catch-up is bounded), never spending policy
    rotationEarlyMarginMs: 60_000,
    counterSettleMs: 120_000,
    counterPollIntervalMs: 1_000,
  };
}

function requiredAsset(code: string, scale: string, which: string): { assetCode: string; assetScale: number } {
  if (code === "") throw new ProofCConfigError(`Proof C requires a nonempty expected ${which} asset code.`);
  const scaleNumber = Number(scale);
  if (!Number.isInteger(scaleNumber) || scaleNumber < 0 || scaleNumber > 255) {
    throw new ProofCConfigError(`Proof C requires an integer ${which} asset scale between 0 and 255.`);
  }
  return { assetCode: code, assetScale: scaleNumber };
}

// pure composition: the ApprovedSpending that pay()/spent() must use after a lifecycle
// rotation. the stale token value is replaced by the rotated authority, the original
// grant continuation is preserved for cleanup, and the conservative request-anchored
// expiry is kept unchanged (never re-derived from installation time). explicit old
// tokens never survive in the result.
export function rotatedApprovedSpending(previous: ApprovedSpending, authority: OutgoingGrantAuthority): ApprovedSpending {
  if (typeof authority.accessToken !== "string" || authority.accessToken === "") {
    throw new Error("The rotated authority carries no usable access token, so the spending authority cannot be replaced.");
  }
  if (typeof authority.manageUrl !== "string" || authority.manageUrl === "") {
    throw new Error("The rotated authority carries no management URI, so the spending authority cannot be replaced.");
  }
  return {
    grant: {
      ...previous.grant,
      // the access metadata is rebuilt canonically from the accepted authority — exact
      // create/read outgoing scope, identifier, current total debit cap, optional
      // receiver — instead of carrying the original token's raw access array forward.
      // the lifecycle core already proved the exact scope/cap/receiver preserved, so
      // this only removes stale scope metadata from the holder without changing policy.
      // the stale advertised lifetime is dropped on purpose; the rotated token's own
      // safe deadline is authority.expiresAt (no expires_in here).
      access_token: {
        value: authority.accessToken,
        manage: authority.manageUrl,
        access: [{
          type: "outgoing-payment",
          actions: ["create", "read"],
          identifier: authority.payerId,
          limits: { debitAmount: authority.budget, ...(authority.receiver === undefined ? {} : { receiver: authority.receiver }) },
        }],
      },
    },
    budget: authority.budget,
    expiresAt: authority.expiresAt,
  };
}

// narrow seams only: type-only imports keep this module side-effect-free at load, and
// structural Picks let tests substitute fake PaymentProofs/lifecycle implementations.
export type ProofCPaymentSeams = Pick<PaymentProofs, "authorize" | "refreshResourceGrants" | "prepare" | "pay"> & {
  readonly sender: Pick<WalletAddress, "id" | "resourceServer">;
};
export type ProofCLifecycleSeams = Pick<OutgoingGrantLifecycle, "requireSpendable" | "readFreshGrantCounter" | "verifySpentCounter" | "rotate" | "getRotationCounterObservations">;

// the actual production composition: consent happens exactly here, the CLOSED-OVER
// spending holder keeps paying through the CURRENT authority, every confirmed rotation
// atomically replaces that holder via rotatedApprovedSpending (old tokens never reach a
// later pay/spent read, the original grant continuation stays for cleanup, and the
// conservative lifecycle expiry is adopted unchanged), and the lifecycle core governs
// scope/counter checks. no module state, no side effects; same object every run.
export function createProofCPorts(
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  payments: ProofCPaymentSeams,
  lifecycle: ProofCLifecycleSeams,
): ProofCPorts {
  let spending: ApprovedSpending | undefined;
  return {
    clock,
    sleep,
    authorizeOutgoing: async (aggregateBudget) => {
      spending = await payments.authorize("C", aggregateBudget);
      return {
        spending,
        authority: {
          accessToken: spending.grant.access_token.value,
          manageUrl: spending.grant.access_token.manage,
          expiresAt: spending.expiresAt,
          payerId: payments.sender.id,
          resourceServerUrl: payments.sender.resourceServer,
          budget: spending.budget,
        },
      };
    },
    requireSpendable: () => lifecycle.requireSpendable(),
    readFreshGrantCounter: (authority) => lifecycle.readFreshGrantCounter({ accessToken: authority.accessToken, budget: authority.budget, resourceServerUrl: authority.resourceServerUrl }),
    readSpentCounter: (authority) => lifecycle.verifySpentCounter({ accessToken: authority.accessToken, budget: authority.budget, resourceServerUrl: authority.resourceServerUrl }),
    rotationCounterObservations: () => lifecycle.getRotationCounterObservations(),
    rotateAuthority: async (authority) => {
      const rotated = await lifecycle.rotate(authority);
      if (!spending) {
        throw new Error("Payment proof C rotated before any spending authority was installed.");
      }
      spending = rotatedApprovedSpending(spending, rotated);
      return rotated;
    },
    refreshResourceGrants: () => payments.refreshResourceGrants(),
    prepareWithQuote: (label) => payments.prepare(label),
    executePayment: (payment, remainingAllowance, perPaymentMaxDebit) => payments.pay(payment, spending!, remainingAllowance, perPaymentMaxDebit),
  };
}

export interface ProofCCleanupOutcome {
  // authority purposes the cleanup retained because a payment stayed unresolved
  retainedForUnresolved: string[];
  warningCount: number;
}

export interface ProofCPorts {
  // monotonic wall clock ms; injected so fake-clock tests never really sleep 25 minutes
  clock(): number;
  // wait ms; an operator abort may reject, which classifies INCONCLUSIVE
  sleep(ms: number): Promise<void>;
  // the ONLY consent path: one interactive approval; the runner never asks for another
  authorizeOutgoing(aggregateBudget: Amount): Promise<{ spending: ApprovedSpending; authority: OutgoingGrantAuthority }>;
  // poisoned lifecycle state must stop everything, including further rotations
  requireSpendable(): void;
  readFreshGrantCounter(authority: OutgoingGrantAuthority): Promise<FreshGrantCounterObservation>;
  readSpentCounter(authority: OutgoingGrantAuthority): Promise<ValidatedSpentCounter>;
  // Actual validated before/after rotation readings; missing readings are never invented.
  rotationCounterObservations(): RotationCounterObservation[];
  // L2 core: remember-before-validate, conservative request-anchored expiry, poisoning.
  // the caller MUST swap its spending holder via rotatedApprovedSpending before any
  // later pay()/spent() read, so old tokens are never used.
  rotateAuthority(authority: OutgoingGrantAuthority): Promise<OutgoingGrantAuthority>;
  // non-interactive incoming/quote maintenance; never new outgoing consent; throws if
  // the provider would require an interaction
  refreshResourceGrants(): Promise<void>;
  prepareWithQuote(label: string): Promise<PreparedPayment>;
  // enforces aggregate remaining allowance AND the explicit per-payment ceiling
  // (including a refreshed quote); never retries a submitted payment
  executePayment(payment: PreparedPayment, remainingAllowance: Amount, perPaymentMaxDebit: Amount): Promise<PaymentEvidence>;
}

export interface ProofCTimelineEvent {
  at: number;
  event: string;
  [detail: string]: unknown;
}

export interface ProofCTransfer {
  label: string;
  submittedAt: number;
  state: PaymentEvidence["state"];
  quotedDebit: Amount;
}

// safe, classified lifecycle evidence: category plus the lifecycle's own sanitized
// detail (provider status, whitelisted code); never a raw provider description
export interface ProofCLifecycleFailure {
  category: string;
  classification?: string;
  providerStatus?: number;
  providerCode?: string;
  counterReason?: GrantCounterFailureReason;
}

const COUNTER_FAILURE_REASONS: readonly GrantCounterFailureReason[] = [
  "READ_FAILED", "MISSING_COUNTER", "MALFORMED_COUNTER", "ASSET_MISMATCH", "EXCEEDS_CAP", "CHANGED_DURING_ROTATION",
];

// protocol enum from the SDK's generated auth-server error schema: these are the ONLY
// code values an authorization-server grant/token response can carry ("invalid_client",
// "invalid_request", "request_denied", "too_fast", "invalid_continuation",
// "invalid_rotation"). anything else is free-form provider text and must not be
// copied into evidence.
export const PROTOCOL_ERROR_CODES = [
  "invalid_client",
  "invalid_request",
  "request_denied",
  "too_fast",
  "invalid_continuation",
  "invalid_rotation",
] as const;

// whitelist guard: proto enum codes pass through, arbitrary provider text is dropped
export function sanitizedProviderCode(code: string | undefined): string | undefined {
  return code !== undefined && (PROTOCOL_ERROR_CODES as readonly string[]).includes(code) ? code : undefined;
}

export interface ProofCEvidence {
  status: ProofCStatus;
  reason: string;
  interactiveApprovals: number;
  // documented alias of interactiveApprovals for operator/evidence readers
  payerInteractions: number;
  intendedTransfers: number;
  executedTransfers: number;
  confirmedTransfers: number;
  rotationsAttempted: number;
  rotationsConfirmed: number;
  initialCounterObservation: "NOT_OBSERVED" | "NUMERIC_ZERO" | "EMPTY_NULLS";
  emptyInitialCounterReconciled: boolean;
  counterReadings: { at: number; value: string }[];
  // Sanitized readings immediately around rotation, including partial failed attempts.
  rotationCounterObservations: RotationCounterObservation[];
  transfers: ProofCTransfer[];
  timeline: ProofCTimelineEvent[];
  lifecycleFailures: ProofCLifecycleFailure[];
  originalAccessTokenLifetimeSeconds?: number;
  originalDeadlineAt?: number;
  paymentAfterOriginalExpiryConfirmed: boolean;
  paymentAfterMinute25Confirmed: boolean;
  providerSpentCounterConsistent: boolean;
  grantRestrictionsPreserved: boolean;
  observationMs: number;
  rotationEarlyMarginMs: number;
  cleanupRetainedAuthorities: string[];
  cleanupWarnings: number;
  durableRecovery: string;
  scopeExclusion: string;
}

// definitive contradictions of the observed experiment
class ProofCFailure extends Error {}
// outcomes that are still uncertain; the experiment stops but nothing is claimed
class ProofCUnknown extends Error {}

// status is NOT_RUN until this function completes from real observations. it never
// hardcodes policy: money comes from config, timing from injected clock/sleep. the
// function classifies and returns; the CLI decides exit codes and overall run status.
export async function runProofC(config: ProofCConfig, ports: ProofCPorts): Promise<ProofCEvidence> {
  const evidence: ProofCEvidence = {
    status: "NOT_RUN",
    reason: "The experiment was not executed.",
    interactiveApprovals: 0,
    payerInteractions: 0,
    intendedTransfers: 3,
    executedTransfers: 0,
    confirmedTransfers: 0,
    rotationsAttempted: 0,
    rotationsConfirmed: 0,
    initialCounterObservation: "NOT_OBSERVED",
    emptyInitialCounterReconciled: false,
    counterReadings: [],
    rotationCounterObservations: [],
    transfers: [],
    timeline: [],
    lifecycleFailures: [],
    paymentAfterOriginalExpiryConfirmed: false,
    paymentAfterMinute25Confirmed: false,
    providerSpentCounterConsistent: false,
    grantRestrictionsPreserved: false,
    observationMs: PROOF_C_OBSERVATION_MS,
    rotationEarlyMarginMs: config.rotationEarlyMarginMs,
    cleanupRetainedAuthorities: [],
    cleanupWarnings: 0,
    durableRecovery: "The process keeps no durable recovery: after exit, reconcile provider history manually and never submit a second debit for an unknown payment.",
    scopeExclusion: "Test Wallet integration evidence only; no offline redemption, durable service or multi-merchant claim is demonstrated.",
  };
  try {
    await executeExperiment(config, ports, evidence);
    evidence.reason = "Three transfers confirmed with at least two pre-expiry rotations and a consistent provider counter over the full 25-minute window.";
    evidence.status = "PASSED";
  } catch (error) {
    if (error instanceof ProofCFailure) {
      evidence.status = "FAILED";
      evidence.reason = error.message;
    } else if (error instanceof ProofCUnknown) {
      evidence.status = "INCONCLUSIVE";
      evidence.reason = error.message;
    } else if (error instanceof GrantLifecycleError) {
      evidence.lifecycleFailures.push({
        category: error.category,
        ...(error.detail?.classification === undefined ? {} : { classification: error.detail.classification }),
        ...(error.detail?.providerStatus === undefined ? {} : { providerStatus: error.detail.providerStatus }),
        // whitelisted protocol enum only; free-form provider code text is dropped
        ...(sanitizedProviderCode(error.detail?.providerCode) === undefined ? {} : { providerCode: sanitizedProviderCode(error.detail?.providerCode) }),
        ...(error.detail?.counterReason !== undefined && COUNTER_FAILURE_REASONS.includes(error.detail.counterReason)
          ? { counterReason: error.detail.counterReason } : {}),
      });
      if (error.category === "ROTATION_REJECTED") {
        evidence.status = "FAILED";
        evidence.reason = "The provider definitively refused a required token rotation; no further transfers were attempted.";
      } else {
        evidence.status = "INCONCLUSIVE";
        evidence.reason = "Lifecycle verification could not confirm authority, scope or counter; spending stays blocked and no further transfers were attempted.";
      }
    } else {
      evidence.lifecycleFailures.push({ category: "UNEXPECTED_ERROR" });
      evidence.status = "INCONCLUSIVE";
      evidence.reason = "An unexpected error stopped the experiment; observed evidence was preserved.";
    }
  }
  // Capture observations even when rotation failed after its pre-rotation read.
  // The lifecycle only exposes sanitized copies and never invents a missing reading.
  try {
    evidence.rotationCounterObservations = ports.rotationCounterObservations();
  } catch {
    evidence.lifecycleFailures.push({ category: "ROTATION_EVIDENCE_UNAVAILABLE" });
    if (evidence.status === "PASSED") {
      evidence.status = "INCONCLUSIVE";
      evidence.reason = "Rotation counter evidence could not be retained; the run is not certified complete.";
    }
  }
  return evidence;
}

// cleanup reported an outcome through the existing ProofRun/PaymentProofs cleanup:
// downgrade a PASSED result, never upgrade anything else
export function applyCleanupOutcome(evidence: ProofCEvidence, outcome: ProofCCleanupOutcome): ProofCEvidence {
  const next: ProofCEvidence = {
    ...evidence,
    cleanupRetainedAuthorities: [...outcome.retainedForUnresolved],
    cleanupWarnings: outcome.warningCount,
  };
  if (next.status === "PASSED" && (outcome.retainedForUnresolved.length > 0 || outcome.warningCount > 0)) {
    return {
      ...next,
      status: "INCONCLUSIVE",
      reason: "Cleanup did not complete cleanly; observed payment evidence stays, but the run is not certified complete.",
    };
  }
  return next;
}

// cleanup threw outright: FAILED/INCONCLUSIVE stay as observed; only a PASSED result
// can no longer be certified complete
export function cleanupFailedEvidence(evidence: ProofCEvidence): ProofCEvidence {
  if (evidence.status !== "PASSED") return evidence;
  return { ...evidence, status: "INCONCLUSIVE", reason: "Cleanup did not complete; the run is not certified complete." };
}

async function executeExperiment(config: ProofCConfig, ports: ProofCPorts, evidence: ProofCEvidence): Promise<void> {
  // exactly one consent; every later step reuses this authority
  const approved = await ports.authorizeOutgoing(config.aggregateBudget);
  evidence.interactiveApprovals = 1;
  evidence.payerInteractions = 1;
  let authority = approved.authority;
  if (authority.expiresAt === undefined) {
    throw new ProofCUnknown("The approved token carries no conservative deadline, so the rotation schedule cannot be planned.");
  }
  const approvalAt = ports.clock();
  const originalDeadline = authority.expiresAt;
  // observed conservative lifetime of the originally installed token (floored seconds)
  evidence.originalDeadlineAt = originalDeadline;
  evidence.originalAccessTokenLifetimeSeconds = Math.floor((originalDeadline - approvalAt) / 1000);
  evidence.timeline.push({ at: approvalAt, event: "consent-completed", originalDeadlineAt: originalDeadline });
  ports.requireSpendable();

  // global high-water mark: a counter reading below any earlier reading is a reset and
  // is never tolerated, even if a later reading would recover to the expected total
  let counterHighWater: bigint | undefined;
  const observeCounter = (reading: ValidatedSpentCounter): bigint => {
    const value = minorValue(reading.spentDebit.value);
    evidence.counterReadings.push({ at: reading.readAt, value: reading.spentDebit.value });
    if (counterHighWater !== undefined && value < counterHighWater) {
      throw new ProofCFailure("The provider's spent counter decreased between readings, so the ledger cannot be verified.");
    }
    counterHighWater = value;
    return value;
  };
  const readCounter = async (): Promise<bigint> => observeCounter(await ports.readSpentCounter(authority));
  // bounded read-only catch-up: the counter must reach exactly the confirmed cumulative
  // debit; overshoot fails immediately and pending stays INCONCLUSIVE
  const settleCounter = async (expected: bigint): Promise<void> => {
    const settleUntil = ports.clock() + config.counterSettleMs;
    for (;;) {
      const value = await readCounter();
      if (value === expected) return;
      if (value > expected) {
        throw new ProofCFailure("The provider's spent counter exceeds the confirmed transfers, so the ledger cannot be verified.");
      }
      if (ports.clock() >= settleUntil) {
        throw new ProofCUnknown("The provider's spent counter did not confirm the settled amounts within the bounded window.");
      }
      await ports.sleep(config.counterPollIntervalMs);
    }
  };
  // rotate early enough to keep a usable margin until the target; rotation timing is
  // slack, never a payment, so a successful rotation alone cannot shorten the gate
  const maintainRotations = async (target: number): Promise<void> => {
    while (authority.expiresAt !== undefined && authority.expiresAt - config.rotationEarlyMarginMs <= target) {
      if (authority.expiresAt <= ports.clock() + config.rotationEarlyMarginMs) {
        throw new ProofCUnknown("The provider's advertised token lifetime leaves no usable rotation margin for the scheduled target.");
      }
      const rotationAt = authority.expiresAt - config.rotationEarlyMarginMs;
      if (ports.clock() < rotationAt) await ports.sleep(rotationAt - ports.clock());
      evidence.rotationsAttempted += 1;
      const rotated = await ports.rotateAuthority(authority);
      // the lifecycle core guarantees an unchanged canonical cap/payer/receiver; a
      // fake-port deviation is a lifecycle contract violation and stays INCONCLUSIVE
      if (!sameAsset(authority.budget, rotated.budget) ||
        minorValue(authority.budget.value) !== minorValue(rotated.budget.value) ||
        authority.payerId !== rotated.payerId || authority.receiver !== rotated.receiver) {
        throw new ProofCUnknown("The rotation changed the accepted grant restrictions, so lifecycle guarantees were not honored.");
      }
      authority = rotated;
      evidence.rotationsConfirmed += 1;
      evidence.grantRestrictionsPreserved = true;
      evidence.timeline.push({ at: ports.clock(), event: "rotation-confirmed", newDeadlineAt: authority.expiresAt });
    }
  };

  // A new isolated grant may return the explicit pair (null, null), meaning the
  // provider has no spent record yet. It is NOT recorded as numeric zero: only
  // the first bounded debit may proceed, and a subsequent numeric counter must
  // equal that confirmed debit before any rotation or second payment is allowed.
  const initial = await ports.readFreshGrantCounter(authority);
  if (initial.kind === "EMPTY") {
    evidence.initialCounterObservation = "EMPTY_NULLS";
    evidence.timeline.push({ at: initial.readAt, event: "fresh-grant-empty-counter" });
  } else {
    const initialValue = observeCounter(initial.reading);
    if (initialValue > 0n) {
      throw new ProofCFailure("The fresh grant already reports nonzero spending, so this run is not isolated.");
    }
    evidence.initialCounterObservation = "NUMERIC_ZERO";
  }
  let cumulative = 0n;

  for (let index = 1; index <= 3; index++) {
    // schedule gates: 1 right after consent, 2 strictly after the original advertised
    // deadline, 3 strictly after 25 minutes since approval (and after transfer 2)
    const paymentTarget = index === 1 ? ports.clock() : index === 2 ? originalDeadline + 1 : approvalAt + PROOF_C_OBSERVATION_MS + 1;
    await maintainRotations(paymentTarget);
    await advanceTo(paymentTarget, ports);
    if (index === 2 && ports.clock() <= originalDeadline) {
      throw new ProofCUnknown("The original-deadline gate was not honored as scheduled.");
    }
    if (index === 3 && ports.clock() <= approvalAt + PROOF_C_OBSERVATION_MS) {
      throw new ProofCUnknown("The 25-minute gate was not honored as scheduled.");
    }
    ports.requireSpendable();
    await ports.refreshResourceGrants();

    // the counter is authoritative for the remaining allowance; reset or drift fails closed
    let remaining: Amount;
    if (index === 1 && evidence.initialCounterObservation === "EMPTY_NULLS") {
      // First transfer only: rely on the newly issued, validated provider cap
      // and explicit per-payment ceiling; never claim a null counter was zero.
      remaining = { ...authority.budget };
    } else {
      const freshValue = await readCounter();
      if (freshValue > cumulative) {
        throw new ProofCFailure("The provider's spent counter exceeds the confirmed transfers, so the ledger cannot be verified.");
      }
      if (freshValue < cumulative) {
        throw new ProofCFailure("The provider's spent counter decreased between confirmed transfers.");
      }
      remaining = { ...authority.budget, value: (minorValue(authority.budget.value) - freshValue).toString() };
    }
    const payment = await ports.prepareWithQuote(`C-payment-${index}`);
    if (!sameAsset(payment.quote.debitAmount, authority.budget)) {
      throw new ProofCFailure("The provider quote uses a different payer asset than the accepted grant cap.");
    }
    const submittedAt = ports.clock();
    let result: PaymentEvidence;
    try {
      result = await ports.executePayment(payment, remaining, config.perPaymentMaxDebit);
    } catch (error) {
      if (payment.evidence.state === "PREPARED") {
        // a pre-POST refusal (ceiling/allowance/quote) is definitive: no debit departed
        throw new ProofCFailure("The submission stopped before any provider debit; the per-payment ceiling or remaining allowance refused the quote.");
      }
      // after a possible POST the recorded provider state decides the accounting
      evidence.executedTransfers += 1;
      evidence.transfers.push({ label: `C-payment-${index}`, submittedAt, state: payment.evidence.state, quotedDebit: payment.quote.debitAmount });
      if (payment.evidence.state === "FAILED" || payment.evidence.state === "REJECTED") {
        throw new ProofCFailure("The provider definitively did not complete the transfer; no further transfers were attempted.");
      }
      throw new ProofCUnknown("The transfer outcome is UNKNOWN; provider IDs are preserved and no further transfers may be attempted.");
    }
    evidence.executedTransfers += 1;
    evidence.transfers.push({ label: `C-payment-${index}`, submittedAt, state: result.state, quotedDebit: result.quotedDebit });
    // an outgoing POST is never retried; whatever happened now sets the course
    if (result.state === "SUCCEEDED") {
      evidence.confirmedTransfers += 1;
      cumulative += minorValue(result.quotedDebit.value);
      await settleCounter(cumulative);
      if (index === 1 && evidence.initialCounterObservation === "EMPTY_NULLS") evidence.emptyInitialCounterReconciled = true;
      if (index === 2 && submittedAt > originalDeadline) evidence.paymentAfterOriginalExpiryConfirmed = true;
      if (index === 3 && submittedAt > approvalAt + PROOF_C_OBSERVATION_MS) evidence.paymentAfterMinute25Confirmed = true;
    } else if (result.state === "FAILED" || result.state === "REJECTED") {
      throw new ProofCFailure("The provider definitively did not complete the transfer; no further transfers were attempted.");
    } else {
      throw new ProofCUnknown("The transfer outcome is UNKNOWN; provider IDs are preserved and no further transfers may be attempted.");
    }
    evidence.timeline.push({ at: ports.clock(), event: `transfer-${index}-settled`, cumulativeDebit: cumulative.toString() });
  }

  if (evidence.confirmedTransfers !== 3 || evidence.executedTransfers !== 3) {
    throw new ProofCUnknown("Fewer than three transfers were confirmed.");
  }
  if (evidence.rotationsConfirmed < 2) {
    throw new ProofCUnknown("Fewer than two pre-expiry rotations were confirmed, so 25-minute token longevity is not demonstrated.");
  }
  // every counter property above was observed to pass; only now may this read true
  evidence.providerSpentCounterConsistent = true;
}

// wait until the target; tolerate clocks (or sleeps) that lag the requested span
async function advanceTo(target: number, ports: ProofCPorts): Promise<void> {
  if (ports.clock() < target) await ports.sleep(target - ports.clock());
  while (ports.clock() < target) await ports.sleep(1);
}
