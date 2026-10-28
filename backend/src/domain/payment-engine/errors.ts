/**
 * Payment-engine domain errors (L3 contract).
 *
 * CLOSED code union, UPPER_SNAKE, stable across releases. Unknown codes
 * must never be invented at call sites — if a new condition is needed,
 * the union is extended deliberately with a documented contract update.
 *
 * Messages are constant, data-free strings. NEVER include provider error
 * bodies, access tokens, secrets, or free-form user PII in `message`.
 * `data` is deliberately not present: sanitized structured detail belongs
 * in SanitizedPaymentEvent payloads, not in error text (L3 keeps errors
 * identity-only).
 */
export type PaymentEngineErrorCode =
  // Authorization lifecycle
  | "GRANT_REAUTHORIZATION_REQUIRED"
  | "GRANT_INVALID"
  | "GRANT_NOT_FOUND"
  // Offline credential lifecycle
  | "OFFLINE_CREDENTIAL_EXPIRED"
  | "OFFLINE_CREDENTIAL_ALREADY_CLAIMED"
  // Guardrails
  | "OVER_TRANSACTION_CEILING"
  | "CUMULATIVE_BUDGET_EXCEEDED"
  // Ambiguity / safety
  | "PAYMENT_OUTCOME_UNKNOWN"
  // Participant integrity
  | "MERCHANT_NOT_VERIFIED"
  | "DEVICE_NOT_VERIFIED"
  // Idempotency and ownership
  | "IDEMPOTENCY_CONFLICT"
  // Claim / atomic reservation
  | "CLAIM_CONFLICT"
  | "CLAIM_INSUFFICIENT_BUDGET"
  | "CLAIM_INVALID"
  // Request validity / construction
  | "INVALID_MONEY"
  | "INVALID_PAYMENT_REQUEST"
  // Ownership and lookup
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_NOT_ACCESSIBLE";

export const PAYMENT_ENGINE_ERROR_CODES: readonly PaymentEngineErrorCode[] = [
  "GRANT_REAUTHORIZATION_REQUIRED",
  "GRANT_INVALID",
  "GRANT_NOT_FOUND",
  "OFFLINE_CREDENTIAL_EXPIRED",
  "OFFLINE_CREDENTIAL_ALREADY_CLAIMED",
  "OVER_TRANSACTION_CEILING",
  "CUMULATIVE_BUDGET_EXCEEDED",
  "PAYMENT_OUTCOME_UNKNOWN",
  "MERCHANT_NOT_VERIFIED",
  "DEVICE_NOT_VERIFIED",
  "IDEMPOTENCY_CONFLICT",
  "CLAIM_CONFLICT",
  "CLAIM_INSUFFICIENT_BUDGET",
  "CLAIM_INVALID",
  "INVALID_MONEY",
  "INVALID_PAYMENT_REQUEST",
  "PAYMENT_NOT_FOUND",
  "PAYMENT_NOT_ACCESSIBLE",
] as const;

/**
 * Constant, data-free messages indexed by code. Domain code MUST use these
 * verbatim; adapters may wrap but must never augment with provider text.
 */
export const PAYMENT_ENGINE_ERROR_MESSAGES: Readonly<
  Record<PaymentEngineErrorCode, string>
> = {
  GRANT_REAUTHORIZATION_REQUIRED:
    "The payment requires the owner to re-authorize the grant before it can continue.",
  GRANT_INVALID: "The referenced grant authorization is not usable in its current state.",
  GRANT_NOT_FOUND: "The referenced grant authorization does not exist under the requesting owner.",
  OFFLINE_CREDENTIAL_EXPIRED: "The offline redemption credential has passed its validity window.",
  OFFLINE_CREDENTIAL_ALREADY_CLAIMED: "The offline redemption credential was already claimed once.",
  OVER_TRANSACTION_CEILING: "The requested debit exceeds the per-payment ceiling.",
  CUMULATIVE_BUDGET_EXCEEDED: "The requested debit exceeds the grant's remaining cumulative budget.",
  PAYMENT_OUTCOME_UNKNOWN: "The payment outcome could not be determined and must not be retried automatically.",
  MERCHANT_NOT_VERIFIED: "The receiving merchant or receiver identity is not verified for this payment.",
  DEVICE_NOT_VERIFIED: "The redeeming device is not enrolled or is revoked.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was already used with a different payment request.",
  CLAIM_CONFLICT: "The device instruction claim conflicts with another concurrent claim.",
  CLAIM_INSUFFICIENT_BUDGET: "The reserved budget could not cover the maximum potential debit.",
  CLAIM_INVALID: "The device instruction claim request is malformed or unbound to its authorization.",
  INVALID_MONEY: "A monetary amount is malformed or outside the allowed form.",
  INVALID_PAYMENT_REQUEST: "The payment request is malformed or internally inconsistent.",
  PAYMENT_NOT_FOUND: "The referenced payment does not exist under the requesting owner.",
  PAYMENT_NOT_ACCESSIBLE: "The referenced payment exists but belongs to a different owner.",
};

export class PaymentEngineError extends Error {
  readonly code: PaymentEngineErrorCode;

  constructor(code: PaymentEngineErrorCode) {
    super(PAYMENT_ENGINE_ERROR_MESSAGES[code]);
    this.name = "PaymentEngineError";
    this.code = code;
  }
}

/** True iff the code is a member of the closed union (for adapters validating boundaries). */
export function isPaymentEngineErrorCode(value: unknown): value is PaymentEngineErrorCode {
  return (
    typeof value === "string" &&
    (PAYMENT_ENGINE_ERROR_CODES as readonly string[]).includes(value)
  );
}
