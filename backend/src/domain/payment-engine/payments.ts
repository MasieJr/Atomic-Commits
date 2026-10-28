/**
 * Payments — core payment-engine domain types (L3 contract).
 *
 * App-visible PaymentStatus is a CLOSED union; proof-only internal states
 * (e.g. provider continuation polling, claim reservation) must NOT leak
 * into these statuses. "UNKNOWN" is a distinct value so callers can tell
 * "definitely failed" apart from "not determinable, do not auto-retry".
 */

import type { Money } from "./money";
import type { PaymentEngineErrorCode } from "./errors";
import type { OfflineEnvelope } from "./offline";
import type { GrantAuthorization } from "./grants";

/** userId is a positive safe integer (existing models store it as a number). */
export type UserId = number;

/** Narrow runtime check shared by every command-hardening path. */
export function isValidUserId(userId: unknown): userId is UserId {
  return typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0;
}

export type PaymentStatus =
  | "AWAITING_AUTHORIZATION"
  | "SUBMITTING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "REJECTED";

/**
 * Status partition:
 * - in progress: work may still change the outcome without owner action;
 * - unresolved: the provider outcome is not determinable and must not be
 *   auto-retried; any reservation stays held until explicit reconciliation;
 * - terminal: confirmed final outcome; safe to release a reservation after
 *   a confirmed failure and safe to stop reconciliation.
 * UNKNOWN is deliberately NOT terminal, even though it is app-visible.
 */
export const IN_PROGRESS_PAYMENT_STATUSES = [
  "AWAITING_AUTHORIZATION",
  "SUBMITTING",
  "PROCESSING",
] as const;

export const UNRESOLVED_PAYMENT_STATUSES = ["UNKNOWN"] as const;

export const NON_TERMINAL_PAYMENT_STATUSES = [
  ...IN_PROGRESS_PAYMENT_STATUSES,
  ...UNRESOLVED_PAYMENT_STATUSES,
] as const;

export const TERMINAL_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
] as const;

export const PAYMENT_STATUSES = [
  ...NON_TERMINAL_PAYMENT_STATUSES,
  ...TERMINAL_PAYMENT_STATUSES,
] as const;

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === "string" &&
    (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalStatus(status: PaymentStatus): boolean {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status);
}

export function isUnresolvedStatus(status: PaymentStatus): boolean {
  return status === "UNKNOWN";
}

export function isInProgressStatus(status: PaymentStatus): boolean {
  return (IN_PROGRESS_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/** Honest payee identity: opaque caller-level identifier, no parsing. */
export interface PayeeIdentity {
  /** Canonical URI-style identity (e.g. wallet address or opaque ref). */
  readonly payeeId: string;
  /** Scope identifier the eligibility check must match against grant scope. */
  readonly merchantScopeId: string;
}

/**
 * A payment the payer wants to make — durable record created on the first
 * request for an idempotency key.
 */
export interface PaymentIntent {
  readonly paymentId: string;
  readonly userId: UserId;
  /** User-supplied idempotency key; uniqueness is scoped per user. */
  readonly idempotencyKey: string;
  readonly merchant: PayeeIdentity;
  /** Exact receive units the merchant is expected to get. */
  readonly merchantReceive: Money;
  /** Optional cap the payer put on their OWN debit for this intent. */
  readonly maxPayerDebit?: Money;
}

/**
 * A single submission track against the provider. An intent may have
 * several attempts (e.g. a prior attempt ended UNKNOWN and the owner
 * explicitly resolved it), but each attempt is submitted exactly once
 * and never retried after UNKNOWN without explicit owner resolution.
 */
export interface PaymentAttempt {
  readonly attemptId: string;
  readonly paymentId: string;
  readonly userId: UserId;
  readonly status: PaymentStatus;
  readonly providerQuoteRef?: string;
  readonly providerAttemptRef?: string;
  readonly quotedPayerDebit?: Money;
  readonly quotedMerchantReceive?: Money;
  readonly startedAtEpochMs?: number;
  readonly resolvedAtEpochMs?: number;
  readonly failureCode?: PaymentEngineErrorCode;
}

/** Terminal (or explicitly-unknown) result surfaced to the caller. */
export interface PaymentResult {
  readonly attemptId: string;
  readonly paymentId: string;
  readonly status: PaymentStatus;
  /** Set only on SUCCEEDED: exact payer debit that settled. */
  readonly payerDebitPaid?: Money;
  /** Set only on SUCCEEDED: exact merchant receive that settled. */
  readonly merchantReceivePaid?: Money;
  readonly failureCode?: PaymentEngineErrorCode;
  readonly resolvedAtEpochMs?: number;
}

/** Command the app layer issues for an online payment. */
export interface OnlinePaymentCommand {
  readonly userId: UserId;
  readonly idempotencyKey: string;
  readonly paymentId: string;
  readonly authorizationId: string;
  readonly merchant: PayeeIdentity;
  /** Exact receive units requested of the merchant side. */
  readonly merchantReceive: Money;
  /** Optional hard cap on the payer's OWN debit; never applied to merchantReceive. */
  readonly maxPayerDebit?: Money;
}

/** Command the app layer issues to redeem an already-issued offline credential. */
export interface OfflineRedemptionCommand {
  readonly userId: UserId;
  readonly paymentId: string;
  readonly authorizationId: string;
  readonly envelope: OfflineEnvelope;
  /** Explicit present-at time injected by the caller; never Date.now inside domain. */
  readonly presentAtEpochMs?: number;
}

/**
 * Quote returned by the provider BEFORE submission: what the payer will
 * be debited and what the merchant will receive. Payer-debit ceiling
 * checks ALWAYS apply against `payerDebit` from this quote — never
 * against `merchantReceive` units.
 */
export interface PaymentQuote {
  readonly attemptId: string;
  readonly providerQuoteRef: string;
  readonly payerDebit: Money;
  readonly merchantReceive: Money;
}

/** Input to the pure eligibility check over grant/amount/merchant/device/clock/envelope. */
export interface EligibilityDecisionInput {
  readonly authorization: GrantAuthorization;
  /** Payer-debit amount from the provider quote, never merchant receive. */
  readonly amountDebit: Money;
  readonly merchantScopeId: string;
  /** Result of the merchant verification check, performed before eligibility. */
  readonly merchantVerified: boolean;
  readonly nowEpochMs: number;
  readonly deviceEnrolled: boolean;
  readonly envelope?: OfflineEnvelope;
}

export interface EligibilityDecision {
  readonly allowed: boolean;
  /** Set when allowed === false; a member of the closed error-code union. */
  readonly denialCode?: PaymentEngineErrorCode;
}
