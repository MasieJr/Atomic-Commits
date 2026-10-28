import { createHash } from "node:crypto";

import { isValidMoney, type Money } from "./money";
import type { ClaimResult } from "./ports";
import {
  evaluateOfflineSpendingPolicy,
  type OfflineDeviceEnrollment,
  type OfflinePolicyContext,
  type OfflinePolicyDenial,
} from "./offline-spending-policy";
import {
  parseSignedOfflineInstruction,
  verifyOfflineInstructionSignature,
} from "./signed-offline-instruction";
import { canonicalize, canonicalUtf8Bytes, type CanonicalLeaf } from "./serialization";

/**
 * The durable adapter MUST atomically revalidate owner/device/grant revocation,
 * expiration, merchant scope, provider authority freshness and all cumulative
 * reservations, then enforce global nonce uniqueness and reserve this ceiling.
 * If it cannot do that, it must refuse, not fall back to a process-local lock.
 */
export interface OfflineAtomicReservationRequest {
  readonly ownerUserId: number;
  readonly envelopeId: string;
  readonly authorizationId: string;
  readonly instructionId: string;
  readonly nonce: string;
  readonly deviceId: string;
  readonly deviceKeyVersion: string;
  readonly expectedDeviceRevocationVersion: number;
  readonly expectedGrantRevocationVersion: number;
  readonly authoritySnapshotId: string;
  readonly authorityValidUntilEpochMs: number;
  readonly instructionExpiresAtEpochMs: number;
  readonly merchantScopeId: string;
  readonly quoteId: string;
  readonly quoteExpiresAtEpochMs: number;
  readonly merchantReceive: Money;
  readonly maxPotentialDebit: Money;
  readonly requestFingerprint: string;
}

export interface OfflineRedemptionPorts {
  /** Registry lookup only; never accept the public key from the QR. */
  loadDeviceEnrollment(envelopeId: string, deviceId: string, keyVersion: string): Promise<OfflineDeviceEnrollment | undefined>;
  /** Load fresh server-owned wallet, device, merchant, provider and budget snapshots. */
  loadContext(envelopeId: string, authenticatedMerchantScopeId: string, merchantReceive: Money): Promise<OfflinePolicyContext | undefined>;
  /** Injected authoritative server clock; never trust the payer device's clock. */
  nowEpochMs(): number;
  claimAndReserve(request: OfflineAtomicReservationRequest): Promise<ClaimResult>;
}

export type OfflineReservationResult =
  | { readonly status: "RESERVED"; readonly paymentId: string; readonly requestFingerprint: string }
  | { readonly status: "REJECTED"; readonly code: OfflinePolicyDenial | "OFFLINE_CREDENTIAL_ALREADY_CLAIMED" | "CLAIM_CONFLICT" }
  | { readonly status: "RESERVATION_UNKNOWN"; readonly instructionId: string; readonly requestFingerprint: string };

/**
 * Verify a QR and reserve its ceiling, never submit a payment. The merchant
 * scope MUST come from an authenticated server-side principal. An ambiguous
 * claim response remains UNKNOWN: reconcile that same claim, never submit a
 * payment or retry the reservation blindly.
 */
export async function reserveSignedOfflineInstruction(
  input: unknown,
  authenticatedMerchantScopeId: string,
  merchantReceive: Money,
  ports: OfflineRedemptionPorts,
): Promise<OfflineReservationResult> {
  const instruction = parseSignedOfflineInstruction(input);
  if (!instruction || typeof authenticatedMerchantScopeId !== "string" || authenticatedMerchantScopeId.length === 0 ||
    !isValidMoney(merchantReceive) || merchantReceive.value === "0" || merchantReceive.value.length > 18) {
    return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" };
  }
  const requestedReceive: Money = Object.freeze({ value: merchantReceive.value, assetCode: merchantReceive.assetCode, assetScale: merchantReceive.assetScale });
  let enrolled: OfflineDeviceEnrollment | undefined;
  try {
    enrolled = await ports.loadDeviceEnrollment(instruction.payload.envelopeId, instruction.payload.deviceId, instruction.payload.keyVersion);
  } catch {
    return { status: "REJECTED", code: "DEVICE_NOT_VERIFIED" };
  }
  if (!enrolled) return { status: "REJECTED", code: "DEVICE_NOT_VERIFIED" };
  // Snapshot the exact key/version that was verified before any subsequent await.
  const verifiedEnrollment: OfflineDeviceEnrollment = { ...enrolled };
  if (verifiedEnrollment.active !== true || verifiedEnrollment.deviceId !== instruction.payload.deviceId ||
    verifiedEnrollment.keyVersion !== instruction.payload.keyVersion || !verifyOfflineInstructionSignature(instruction, verifiedEnrollment.publicKey)) {
    return { status: "REJECTED", code: "DEVICE_NOT_VERIFIED" };
  }
  let context: OfflinePolicyContext | undefined;
  try {
    context = await ports.loadContext(instruction.payload.envelopeId, authenticatedMerchantScopeId, requestedReceive);
  } catch {
    return { status: "REJECTED", code: "GRANT_REAUTHORIZATION_REQUIRED" };
  }
  if (!context) return { status: "REJECTED", code: "GRANT_REAUTHORIZATION_REQUIRED" };
  if (!context.device || context.device.ownerUserId !== verifiedEnrollment.ownerUserId || context.device.publicKey !== verifiedEnrollment.publicKey ||
    context.device.revocationVersion !== verifiedEnrollment.revocationVersion) {
    return { status: "REJECTED", code: "DEVICE_NOT_VERIFIED" };
  }
  if (!context.merchant || context.merchant.scopeId !== authenticatedMerchantScopeId) {
    return { status: "REJECTED", code: "MERCHANT_NOT_VERIFIED" };
  }
  let now: number;
  try {
    now = ports.nowEpochMs();
  } catch {
    return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" };
  }
  const decision = evaluateOfflineSpendingPolicy(instruction.payload, { ...context, nowEpochMs: now, expectedMerchantReceive: requestedReceive });
  if (!decision.allowed) return { status: "REJECTED", code: decision.code };

  // Bind the authenticated merchant and requested receive amount as well as the
  // signed instruction. Provider quote IDs are deliberately not fingerprinted.
  const fingerprintBytes = canonicalUtf8Bytes(canonicalize({ version: "1", body: {
    purpose: "atomic-commits/offline-redemption",
    instruction: instruction.payload as unknown as CanonicalLeaf,
    merchantScopeId: authenticatedMerchantScopeId,
    merchantReceive: { ...requestedReceive },
  } }));
  const fingerprint = createHash("sha256").update(fingerprintBytes).digest("hex");
  const request: OfflineAtomicReservationRequest = {
    ownerUserId: context.envelope.ownerUserId,
    envelopeId: instruction.payload.envelopeId,
    authorizationId: instruction.payload.authorizationId,
    instructionId: instruction.payload.instructionId,
    nonce: instruction.payload.nonce,
    deviceId: instruction.payload.deviceId,
    deviceKeyVersion: instruction.payload.keyVersion,
    expectedDeviceRevocationVersion: context.envelope.deviceRevocationVersion,
    expectedGrantRevocationVersion: context.envelope.grantRevocationVersion,
    authoritySnapshotId: context.authority.snapshotId,
    authorityValidUntilEpochMs: context.authority.validUntilEpochMs,
    instructionExpiresAtEpochMs: instruction.payload.expiresAtEpochMs,
    merchantScopeId: authenticatedMerchantScopeId,
    quoteId: context.quote.quoteId,
    quoteExpiresAtEpochMs: context.quote.expiresAtEpochMs,
    merchantReceive: requestedReceive,
    maxPotentialDebit: { ...decision.maxPotentialDebit },
    requestFingerprint: fingerprint,
  };
  let result: ClaimResult;
  try {
    result = await ports.claimAndReserve(request);
  } catch {
    return { status: "RESERVATION_UNKNOWN", instructionId: request.instructionId, requestFingerprint: fingerprint };
  }
  if (result?.kind === "CLAIMED" && typeof result.paymentId === "string" && result.paymentId.length > 0) {
    return { status: "RESERVED", paymentId: result.paymentId, requestFingerprint: fingerprint };
  }
  if (result?.kind === "ALREADY_CLAIMED") return { status: "REJECTED", code: "OFFLINE_CREDENTIAL_ALREADY_CLAIMED" };
  if (result?.kind === "INSUFFICIENT_BUDGET") return { status: "REJECTED", code: "CUMULATIVE_BUDGET_EXCEEDED" };
  if (result?.kind === "CONFLICT") return { status: "REJECTED", code: "CLAIM_CONFLICT" };
  if (result?.kind === "INVALID") return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" };
  // An invalid response might follow a committed claim, so it is not a safe rejection.
  return { status: "RESERVATION_UNKNOWN", instructionId: request.instructionId, requestFingerprint: fingerprint };
}
