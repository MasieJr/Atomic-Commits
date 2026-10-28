/**
 * Payment events (L3 contract) — sanitized, exactly-once-identified
 * observations about a payment lifecycle.
 *
 * SANITIZATION INVARIANT: sanitized event payloads CONTAIN NO access
 * tokens, NO private keys or secrets, NO raw provider error text, and NO
 * unnecessary PII (no full addresses beyond opaque ids, no device keys).
 * Source-derived free text is decomposed into enum-like fields; anything
 * not explicitly modeled must be dropped before the event enters the
 * domain-visible surface.
 */

import { isValidMoney, type Money } from "./money";
import { isPaymentStatus, type PaymentStatus } from "./payments";
import { isPaymentEngineErrorCode, type PaymentEngineErrorCode } from "./errors";

/** Closed, stable event-type union. Must never include provider-specific enum values. */
export type PaymentEventType =
  | "PAYMENT_INTENT_CREATED"
  | "ELIGIBILITY_DENIED"
  | "QUOTE_CREATED"
  | "PAYMENT_SUBMITTED"
  | "PAYMENT_PROCESSING"
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_FAILED"
  | "PAYMENT_OUTCOME_UNKNOWN"
  | "PAYMENT_REJECTED"
  | "GRANT_REAUTHORIZATION_REQUIRED"
  | "OFFLINE_CREDENTIAL_CLAIMED"
  | "CLAIM_CONFLICT";

/**
 * Exact-once identity: `eventId` is the caller-generated, globally
 * unique identity of one state transition (deterministic for that
 * transition so retries produce the same id). The persistence adapter
 * must persist at most once per (userId, eventId); outbox/transaction
 * wiring is adapter scope.
 */
export interface SanitizedPaymentEvent {
  readonly eventId: string;
  readonly userId: number;
  readonly paymentId: string;
  /** Attempt may be absent for intent-level events. */
  readonly attemptId?: string;
  readonly type: PaymentEventType;
  readonly occurredAtEpochMs: number;
  /** Sanitized structured payload, NO secrets and NO provider error text. */
  readonly payload: SanitizedEventPayload;
}

export type SanitizedEventPayload =
  | { readonly kind: "status"; readonly status: PaymentStatus }
  | {
      readonly kind: "money";
      /** Which side of the payment this money applies to. */
      readonly side: "PAYER_DEBIT" | "MERCHANT_RECEIVE" | "UNSPECIFIED";
      readonly amount: Money;
    }
  | { readonly kind: "failure"; readonly code: PaymentEngineErrorCode }
  | { readonly kind: "quote"; readonly quoteProviderRef: string }
  | { readonly kind: "attempt"; readonly attemptProviderRef: string }
  | { readonly kind: "claim"; readonly instructionId: string; readonly nonce: string }
  | { readonly kind: "none" };

const PAYLOAD_KEYS: Readonly<Record<SanitizedEventPayload["kind"], readonly string[]>> = {
  status: ["kind", "status"],
  money: ["kind", "side", "amount"],
  failure: ["kind", "code"],
  quote: ["kind", "quoteProviderRef"],
  attempt: ["kind", "attemptProviderRef"],
  claim: ["kind", "instructionId", "nonce"],
  none: ["kind"],
};

/**
 * Strict runtime guard for sanitized payloads: the kind must be known,
 * no unmodeled keys may be present (prevents smuggling raw provider text
 * or secrets through extra properties), and each field must match its
 * declared domain shape. Callers still must never put secrets in the
 * modeled fields.
 */
export function isPayloadSanitized(payload: unknown): payload is SanitizedEventPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(PAYLOAD_KEYS, kind)) {
    return false;
  }
  const allowedKeys = PAYLOAD_KEYS[kind as SanitizedEventPayload["kind"]];
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) return false;

  switch (kind) {
    case "status":
      return isPaymentStatus(record.status);
    case "money": {
      const side = record.side;
      return (
        (side === "PAYER_DEBIT" || side === "MERCHANT_RECEIVE" || side === "UNSPECIFIED") &&
        isValidMoney(record.amount)
      );
    }
    case "failure":
      return isPaymentEngineErrorCode(record.code);
    case "quote":
      return typeof record.quoteProviderRef === "string" && record.quoteProviderRef.length > 0;
    case "attempt":
      return (
        typeof record.attemptProviderRef === "string" && record.attemptProviderRef.length > 0
      );
    case "claim":
      return (
        typeof record.instructionId === "string" &&
        record.instructionId.length > 0 &&
        typeof record.nonce === "string" &&
        record.nonce.length > 0
      );
    case "none":
      return true;
    default:
      return false;
  }
}
