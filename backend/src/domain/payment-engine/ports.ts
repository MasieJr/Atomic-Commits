/**
 * Ports — transport-independent interfaces the engine depends on (L3).
 *
 * RULES
 * - Ports import NOTHING from src/services/**, Open Payments SDK,
 *   Express, pg, Supabase, FCM, or ambient time (Date is not referenced).
 * - Every domain decision uses ClockPort.nowEpochMs() for time; no port may
 *   call Date.now internally against policy.
 * - Ports are mockable in-memory: methods are small, values are narrow
 *   readonly domain types, never raw SDK objects.
 */

import type { Money } from "./money";
import type {
  EligibilityDecision,
  EligibilityDecisionInput,
  OnlinePaymentCommand,
  OfflineRedemptionCommand,
  PayeeIdentity,
  PaymentAttempt,
  PaymentResult,
  PaymentQuote,
  UserId,
} from "./payments";
import type {
  GrantAuthorization,
  GrantAuthorizationStatus,
} from "./grants";
import type {
  InstructionNonce,
  OfflineEnvelope,
  SignedInstruction,
  RedemptionClaim,
} from "./offline";
import type { SanitizedPaymentEvent } from "./events";
import type { PaymentEngineErrorCode } from "./errors";
import type { IdempotencyResolution } from "./idempotency";

/** Injected time source; domain logic must NEVER call Date.now directly. */
export interface ClockPort {
  readonly nowEpochMs: () => number;
}

/**
 * Provider-facing quote/submission/status boundary.
 *
 * SUBMIT SAFETY: submit is SINGLE-SHOT. Once an attempt has been
 * submitted and the outcome is not definitively returned, the provider
 * status read ONLY; never re-submit the same attempt (double debit
 * risk). An ambiguous provider response maps to PaymentStatus "UNKNOWN"
 * and must not be treated as a failure with automatic retry.
 */
export interface PaymentsProviderPort {
  createQuote(refs: QuoteRequest): Promise<PaymentQuote>;
  /**
   * Submit the payment exactly once for this attemptId. If the provider
   * responds ambiguously, return status "UNKNOWN". Adapters must not
   * silently re-issue submission on transport errors.
   */
  submitPayment(attemptId: string, quoteRef: string, userId: UserId): Promise<PaymentAttempt>;
  /** Read-only provider status reconciliation for an attempt. */
  readProviderStatus(refs: ProviderStatusRequest): Promise<ProviderStatusReconciliation>;
}

export interface QuoteRequest {
  readonly userId: UserId;
  readonly attemptId: string;
  /** Payee identity, including the merchant scope used by eligibility. */
  readonly payee: PayeeIdentity;
  readonly merchantReceive: Money;
  readonly maxPayerDebit?: Money;
}

export interface ProviderStatusRequest {
  readonly userId: UserId;
  readonly attemptId: string;
  /**
   * Provider reference captured during submission. May be absent when the
   * provider response was ambiguous; in that case the adapter returns
   * UNRESOLVED rather than inventing a reference or re-submitting.
   */
  readonly providerAttemptRef?: string;
}

/**
 * Reconciliation view from provider status read; "UNRESOLVED" keeps
 * engine-side state unknown rather than prematurely declaring failure.
 * A confirmed provider status can only be PROCESSING or a terminal
 * provider outcome; it can never be AWAITING_AUTHORIZATION/SUBMITTING
 * and can never claim UNKNOWN as confirmed.
 */
export type ProviderConfirmedStatus =
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "REJECTED";

export type ProviderStatusReconciliation =
  | {
      readonly kind: "CONFIRMED";
      readonly status: ProviderConfirmedStatus;
      readonly result?: PaymentResult;
    }
  | { readonly kind: "UNRESOLVED" };

/**
 * Grant lifecycle boundary: load and validate provider grant authority,
 * rotate token authority (leading to a NEW authorityRef), cancel.
 *
 * DOMAIN-FACING VALUES CONTAIN NO RAW TOKENS. Unknown rotation
 * outcomes must remain unknown (port returns UNRESOLVED) and must NOT
 * trigger fresh consent flows or double debits.
 */
export interface GrantLifecyclePort {
  /** Load live grant authority by id; throws GRANT_NOT_FOUND / GRANT_INVALID as PaymentEngineError. */
  loadAuthorization(args: GrantLookup): Promise<GrantAuthorization>;
  /**
   * Rotate the underlying access authority for a grant. On ambiguous
   * outcome returns UNRESOLVED; on success returns a new authorityRef.
   * Never triggers interactive consent.
   */
  rotateAuthority(args: GrantLookup): Promise<GrantRotationOutcome>;
  /** Cancel the grant; idempotent per-grant from the engine's perspective. */
  cancelAuthorization(args: GrantLookup): Promise<void>;
}

export interface GrantLookup {
  readonly userId: UserId;
  readonly authorizationId: string;
}

export type GrantRotationOutcome =
  | { readonly kind: "ROTATED"; readonly authorizationId: string; readonly newAuthorityRef: string; readonly newStatus: GrantAuthorizationStatus }
  | { readonly kind: "UNRESOLVED" };

/**
 * Persistence boundary. The ADAPTER (not the domain) owns DB
 * transactions and the transactional outbox. There is NO SQL here, and
 * no requirement that a single DB engine backs these methods.
 *
 * Every call must scope results to the given userId — cross-user reads
 * must behave as not-found so ownership never leaks.
 */
export interface PaymentRepositoryPort {
  /** Find an existing idempotency resolution; NEVER crosses userId boundaries. */
  findIdempotentResolution(args: IdempotentLookup): Promise<IdempotencyResolutionView | undefined>;
  /** Insert-or-resolve a new idempotency record; adapter enforces unique(userId, key). */
  createIdempotentResolution(args: IdempotentCreate): Promise<IdempotencyResolutionView>;
  /** Load a payment attempt scoped to the owner; undefined for foreign owner. */
  loadAttempt(args: AttemptLookup): Promise<PaymentAttempt | undefined>;
  /** Persist attempt state transitions; adapter owns transaction boundaries. */
  saveAttempt(args: AttemptCreate): Promise<void>;
  /** Load terminal-or-unknown result scoped to the owner. */
  loadResult(args: AttemptLookup): Promise<PaymentResult | undefined>;
  /** Persist result; confirmed terminal outcomes are final, but UNKNOWN remains reconcilable. */
  saveResult(args: ResultPersist): Promise<void>;
  /** Load grant authorization scoped to the owner. */
  loadGrantAuthorization(args: GrantLookup): Promise<GrantAuthorization | undefined>;
}

/**
 * Canonical idempotency outcome, including the hard-conflict case where
 * the key exists but the canonical request fingerprint differs.
 */
export type IdempotencyResolutionView = IdempotencyResolution;

export type IdempotentLookup = {
  readonly userId: UserId;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
};

export type IdempotentCreate = IdempotentLookup & {
  readonly paymentId: string;
  readonly attemptId: string;
};

export interface AttemptLookup {
  readonly userId: UserId;
  readonly attemptId: string;
}

export interface AttemptCreate {
  readonly userId: UserId;
  readonly attempt: PaymentAttempt;
}

export interface ResultPersist {
  readonly userId: UserId;
  readonly result: PaymentResult;
}

/**
 * Globally-unique atomic claim across replicas.
 *
 * `claimInstructionAndReserveBudget` must be realized with a mutation
 * that is unique across every node in the system (adapter picks an
 * appropriate transactional primitive). Reservation semantics:
 * - Held on UNKNOWN outcome (never auto-released early).
 * - Released only after a CONFIRMED failure.
 * - Never allows the reservation to cause a debit beyond the
 *   authorization's per-payment ceiling.
 */
export interface AtomicClaimPort {
  claimInstructionAndReserveBudget(args: ClaimRequest): Promise<ClaimResult>;
  /** Explicitly release a held reservation after CONFIRMED failure only. */
  releaseReservation(args: ReleaseRequest): Promise<void>;
  /** Only after a CONFIRMED success: convert reservation into a recorded claim. */
  recordClaim(args: RecordClaimRequest): Promise<RedemptionClaim>;
}

export interface ClaimRequest {
  readonly userId: UserId;
  readonly instructionId: string;
  /** Instruction nonce; global single-use uniqueness must be keyed on this. */
  readonly nonce: InstructionNonce;
  readonly envelopeId: string;
  readonly authorizationId: string;
  /** Upper bound committed at claim time; must be <= perPaymentMaxDebit. */
  readonly maxPotentialDebit: Money;
  readonly requestFingerprint: string;
}

export type ClaimResult =
  | { readonly kind: "CLAIMED"; readonly paymentId: string }
  | {
      readonly kind: "ALREADY_CLAIMED";
      /** Instruction that already consumed this nonce (may differ from the replaying instructionId). */
      readonly priorInstructionId: string;
    }
  | { readonly kind: "INSUFFICIENT_BUDGET"; readonly code: "CLAIM_INSUFFICIENT_BUDGET" }
  | { readonly kind: "CONFLICT"; readonly code: "CLAIM_CONFLICT" }
  | { readonly kind: "INVALID"; readonly code: "CLAIM_INVALID" };

/**
 * The adapter must retain the owner/instruction/authorization-to-nonce
 * association established by the atomic claim and use it to locate the
 * reservation. Releasing budget must not erase the nonce's replay record.
 */
export interface ReleaseRequest {
  readonly userId: UserId;
  readonly instructionId: string;
  readonly authorizationId: string;
}

export interface RecordClaimRequest {
  readonly userId: UserId;
  readonly envelopeId: string;
  readonly instructionId: string;
  readonly nonce: InstructionNonce;
  readonly authorizationId: string;
  readonly deviceEnrollmentId: string;
  /** Must match the stored reservation; becomes RedemptionClaim.reservedMaxDebit. */
  readonly reservedMaxDebit: Money;
  readonly claimedAtEpochMs: number;
}

/**
 * Device verification boundary. NO crypto implementation here: the
 * adapter decides whether a signature over canonical bytes is valid
 * for an enrolled device. Checks enrollment AND revocation BEFORE
 * the claim is allowed.
 */
export interface DeviceVerificationPort {
  verify(args: DeviceVerificationRequest): Promise<DeviceVerificationOutcome>;
}

export interface DeviceVerificationRequest {
  readonly userId: UserId;
  readonly envelope: OfflineEnvelope;
  readonly instruction: SignedInstruction;
  readonly nowEpochMs: number;
}

export type DeviceVerificationOutcome =
  | { readonly kind: "VERIFIED"; readonly deviceEnrollmentId: string }
  | { readonly kind: "NOT_ENROLLED"; readonly code: "DEVICE_NOT_VERIFIED" }
  | { readonly kind: "REVOKED"; readonly code: "DEVICE_NOT_VERIFIED" }
  | { readonly kind: "SIGNATURE_INVALID"; readonly code: "DEVICE_NOT_VERIFIED" };

/**
 * Verification sink for events: record(sanitizedEvent) should be
 * called AT MOST ONCE per eventId; the persistence adapter enforces
 * this exactly-once identity when persisting alongside the payment
 * state transaction (transactional outbox belongs to adapter scope).
 */
export interface PaymentEventsPort {
  record(event: SanitizedPaymentEvent): Promise<void>;
}

/**
 * Pure payment eligibility policy. Returns allow/deny with an
 * error-code from the closed union. This is a policy CONTRACT only —
 * the implementation is expected in the engine domain (no adapter) and
 * uses no ambient time or provider objects.
 */
export interface PaymentEligibilityPort {
  evaluate(input: EligibilityDecisionInput): EligibilityDecision;
}

/**
 * PaymentEngine — pure orchestration contract. No implementation
 * lives here in L3; the factory/function that composes these ports is
 * expected in the engine implementation (owned by future steps).
 */
export interface PaymentEngine {
  online(command: OnlinePaymentCommand, clock: ClockPort): Promise<PaymentResult>;
  redeemOffline(command: OfflineRedemptionCommand, clock: ClockPort): Promise<PaymentResult>;
  /** Throws PaymentEngineError(PAYMENT_NOT_FOUND) for both unknown and foreign payments. */
  statusOf(args: PaymentStatusLookup): Promise<PaymentResult>;
}

export interface PaymentStatusLookup {
  readonly userId: UserId;
  readonly paymentId: string;
}

/** Narrow required code union (used when constructing engine-level denials). */
export type DenialCode = PaymentEngineErrorCode;
