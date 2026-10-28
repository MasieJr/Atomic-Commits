/**
 * Grants — provider grant authorization domain types (L3 contract).
 *
 * SECURITY INVARIANT: GrantAuthorization NEVER carries raw access tokens,
 * token continuations, or wallet secrets. It references authority by
 * opaque, provider-side references only ("" prefixed identifiers):
 * the actual secret-material lookup happens inside the adapter owning
 * the GrantLifecyclePort, and adapter storage may hold secrets at rest,
 * but no domain type or event ever exposes them.
 */

import type { Money } from "./money";

/**
 * Closed lifecycle status of a provider grant authority.
 * NONE of these values imply "authorized for spending" by themselves;
 * eligibility checks re-validate scope/budgets/devices per payment.
 */
export type GrantAuthorizationStatus =
  | "ACTIVE"
  | "ROTATING"
  | "BLOCKED"
  | "REAUTHORIZATION_REQUIRED"
  | "REVOKED"
  | "EXPIRED";

export type GrantAccessKind = "OUTGOING_PAYMENT" | "INCOMING_PAYMENT" | "READ_ONLY";

/** Opaque reference to a provider access authority (never a literal token). */
export type GrantAuthorityRef = string;

export interface GrantAuthorization {
  readonly authorizationId: string;
  readonly userId: number;
  readonly status: GrantAuthorizationStatus;
  /** Opaque authority reference used for provider calls; no token bytes here. */
  readonly authorityRef: GrantAuthorityRef;
  readonly kind: GrantAccessKind;
  /** Asset cap for any single payment's PAYER DEBIT (from provider quote). */
  readonly perPaymentMaxDebit: Money;
  /** Cumulative cap across all payments from this grant. */
  readonly cumulativeCap: Money;
  /** Amount already spent/committed within the cumulative cap. */
  readonly cumulativeSpent: Money;
  /** Inclusive validity window in epoch milliseconds (UTC). */
  readonly validFromEpochMs: number;
  readonly validUntilEpochMs: number;
  /** Asset the PAYER will be debited in. */
  readonly payerAssetCode: string;
  readonly payerAssetScale: number;
  /** Opaque binding for the intended receiver; interpreted by the adapter layer. */
  readonly receiverBindingId?: string;
  /**
   * Merchant scope this grant can pay into. Absent means the grant is
   * unbound and may pay any verified merchant within the asset; when
   * present, eligibility requires an exact id match. Never use a
   * sentinel string such as "ANY" for the unbound case.
   */
  readonly merchantScopeId?: string;
  /** Revocation marker, incremented whenever owners revoke or rotate scopes. */
  readonly revocationVersion: number;
}

/** True iff clock time is inside the grant's validity window. */
export function isGrantWithinValidityWindow(
  grant: GrantAuthorization,
  nowEpochMs: number
): boolean {
  return nowEpochMs >= grant.validFromEpochMs && nowEpochMs <= grant.validUntilEpochMs;
}

/**
 * True iff the grant permits paying the given merchant scope. An absent
 * grant scope is unbound (any verified merchant); a present scope is an
 * exact-match restriction.
 */
export function grantAllowsMerchantScope(
  grant: GrantAuthorization,
  merchantScopeId: string
): boolean {
  if (merchantScopeId.length === 0) return false;
  return grant.merchantScopeId === undefined || grant.merchantScopeId === merchantScopeId;
}
