/**
 * Idempotency and ownership semantics (L3 contract).
 *
 * OWNERSHIP
 * - Every read and write is scoped to a POSITIVE SAFE-INTEGER userId.
 * - (userId, idempotencyKey) is globally unique across the persistence
 *   layer: two different users may safely reuse the same string key
 *   without ever observing each other's work.
 * - An actor whose userId does not match a stored payment's userId MUST
 *   NOT be able to learn anything about that payment — reads either
 *   return PAYMENT_NOT_FOUND-style unavailability or a code that does
 *   not reveal existence; ownership mismatch never leaks another user's
 *   payment identifiers or money values in errors.
 *
 * IDEMPOTENCY
 * - Same (userId, idempotencyKey) + SAME canonical request fingerprint:
 *   returns the original attempt/result without creating a new attempt.
 * - Same (userId, idempotencyKey) + DIFFERENT fingerprint: hard conflict
 *   (PaymentEngineErrorCode.IDEMPOTENCY_CONFLICT), never a silent
 *   different-execution.
 * - Fingerprints are computed over a canonical serialization of the
 *   command (see serialization.ts); provider-supplied identifiers like
 *   quote refs are NOT part of the fingerprint.
 *
 * This module defines TYPES and SEMANTICS ONLY — persistence resides in
 * the storage adapter (Josue), which owns DB transactions and the
 * outbox. There is NO SQL here.
 */

import type { PaymentResult, PaymentStatus, UserId } from "./payments";

/** Positive safe integer; alternativeUserId never differs from userId on lookup. */
export type IdempotentOwnerScope = {
  readonly userId: UserId;
  readonly idempotencyKey: string;
};

/**
 * Lowercase hexadecimal SHA-256 of the canonical UTF-8 request bytes
 * (see serialization.ts). The hash implementation (crypto) is adapter
 * scope; the FORMAT is fixed here so two implementations can compare
 * fingerprints safely.
 */
export type RequestFingerprint = string;

const REQUEST_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Outcome of an idempotency-first command resolution. */
export type IdempotencyResolution =
  | {
      readonly kind: "PREVIOUS";
      readonly paymentId: string;
      readonly attemptId: string;
      readonly status: PaymentStatus;
      readonly result?: PaymentResult;
    }
  | {
      readonly kind: "NEW";
      readonly paymentId: string;
    }
  | {
      readonly kind: "CONFLICT";
      readonly conflictCode: "IDEMPOTENCY_CONFLICT";
    };

/** Pure predicate for fingerprint-shape checking (no crypto here). */
export function isWellFormedFingerprint(fp: unknown): fp is RequestFingerprint {
  return typeof fp === "string" && REQUEST_FINGERPRINT_PATTERN.test(fp);
}
