import type { GrantAuthorization } from "./grants";
import { isValidMoney, sameAsset, type Money } from "./money";
import { isValidUserId } from "./payments";
import type { OfflineInstructionV1 } from "./signed-offline-instruction";

/** Server-issued enrollment, separate from each device-created instruction. */
export interface OfflineSpendingEnvelope {
  readonly version: "1";
  readonly envelopeId: string;
  readonly authorizationId: string;
  readonly ownerUserId: number;
  readonly payerWalletId: string;
  readonly deviceId: string;
  readonly deviceKeyVersion: string;
  readonly deviceRevocationVersion: number;
  readonly grantRevocationVersion: number;
  readonly perPaymentMaxDebit: Money;
  readonly cumulativeCap: Money;
  readonly validFromEpochMs: number;
  readonly validUntilEpochMs: number;
  readonly revoked: boolean;
  readonly merchantScopeId?: string;
}

/** Loaded from trusted server-side enrollment, never from the QR. */
export interface OfflineDeviceEnrollment {
  readonly ownerUserId: number;
  readonly deviceId: string;
  readonly keyVersion: string;
  readonly revocationVersion: number;
  readonly active: boolean;
  readonly publicKey: string;
}

/** Fresh provider state; missing or unverified permission is never treated as usable. */
export interface OfflineProviderAuthority {
  readonly ownerUserId: number;
  readonly authorizationId: string;
  readonly payerWalletId: string;
  readonly usable: boolean;
  readonly restrictionsVerified: boolean;
  /** Server-controlled identity and validity window for the verified authority snapshot. */
  readonly snapshotId: string;
  readonly observedAtEpochMs: number;
  readonly validUntilEpochMs: number;
  readonly cumulativeCap: Money;
  readonly spentDebit: Money;
}

export interface OfflinePolicyContext {
  readonly nowEpochMs: number;
  readonly envelope: OfflineSpendingEnvelope;
  readonly grant: GrantAuthorization;
  readonly authority: OfflineProviderAuthority;
  readonly device: OfflineDeviceEnrollment;
  readonly wallet: { readonly ownerUserId: number; readonly walletId: string; readonly verified: boolean };
  readonly merchant: { readonly scopeId: string; readonly walletId: string; readonly verified: boolean };
  /** Server-observed quote for the authenticated merchant, not caller-supplied debit data. */
  readonly quote: {
    readonly quoteId: string;
    readonly merchantScopeId: string;
    readonly payerWalletId: string;
    readonly receiverWalletId: string;
    readonly payerDebit: Money;
    readonly merchantReceive: Money;
    readonly expiresAtEpochMs: number;
  };
  readonly expectedMerchantReceive: Money;
  /** All outstanding debit reservations, including unresolved submissions. */
  readonly outstandingReservations: Money;
}

export type OfflinePolicyDenial =
  | "INVALID_PAYMENT_REQUEST"
  | "GRANT_REAUTHORIZATION_REQUIRED"
  | "DEVICE_NOT_VERIFIED"
  | "MERCHANT_NOT_VERIFIED"
  | "OFFLINE_CREDENTIAL_EXPIRED"
  | "OVER_TRANSACTION_CEILING"
  | "CUMULATIVE_BUDGET_EXCEEDED";

export type OfflinePolicyDecision =
  | { readonly allowed: true; readonly maxPotentialDebit: Money }
  | { readonly allowed: false; readonly code: OfflinePolicyDenial };

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validMoney(value: unknown, positive = false): value is Money {
  return isValidMoney(value) && value.value.length <= 18 && (!positive || value.value !== "0");
}

function denial(code: OfflinePolicyDenial): OfflinePolicyDecision {
  return { allowed: false, code };
}

/**
 * Pure, conservative pre-claim decision. This is not a reservation: a durable
 * adapter must recheck revocation, time and budgets atomically before claiming.
 * Server time is authoritative; this version permits no client-clock grace.
 */
export function evaluateOfflineSpendingPolicy(instruction: OfflineInstructionV1, context: OfflinePolicyContext): OfflinePolicyDecision {
  try {
    const { envelope, grant, authority, device, wallet, merchant, quote, nowEpochMs } = context;
    if (!validTimestamp(nowEpochMs) || !envelope || !grant || !authority || !device || !wallet || !merchant || !quote) return denial("INVALID_PAYMENT_REQUEST");
    if (
      envelope.version !== "1" || envelope.revoked !== false || !isValidUserId(envelope.ownerUserId) ||
      !Number.isSafeInteger(envelope.grantRevocationVersion) || envelope.grantRevocationVersion < 0 ||
      !Number.isSafeInteger(envelope.deviceRevocationVersion) || envelope.deviceRevocationVersion < 0 ||
      !validTimestamp(envelope.validFromEpochMs) || !validTimestamp(envelope.validUntilEpochMs) || envelope.validFromEpochMs >= envelope.validUntilEpochMs ||
      !validTimestamp(grant.validFromEpochMs) || !validTimestamp(grant.validUntilEpochMs) || grant.validFromEpochMs >= grant.validUntilEpochMs ||
      !validTimestamp(instruction.issuedAtEpochMs) || !validTimestamp(instruction.expiresAtEpochMs) || instruction.issuedAtEpochMs >= instruction.expiresAtEpochMs
    ) return denial("INVALID_PAYMENT_REQUEST");
    if (
      instruction.issuedAtEpochMs < envelope.validFromEpochMs || instruction.expiresAtEpochMs > envelope.validUntilEpochMs ||
      instruction.issuedAtEpochMs > nowEpochMs || nowEpochMs >= instruction.expiresAtEpochMs ||
      nowEpochMs < envelope.validFromEpochMs || nowEpochMs >= envelope.validUntilEpochMs ||
      nowEpochMs < grant.validFromEpochMs || nowEpochMs >= grant.validUntilEpochMs
    ) return denial("OFFLINE_CREDENTIAL_EXPIRED");
    if (
      instruction.version !== "1" || instruction.envelopeId !== envelope.envelopeId ||
      instruction.authorizationId !== envelope.authorizationId || grant.authorizationId !== envelope.authorizationId ||
      authority.authorizationId !== envelope.authorizationId || grant.userId !== envelope.ownerUserId ||
      authority.ownerUserId !== envelope.ownerUserId || wallet.ownerUserId !== envelope.ownerUserId ||
      wallet.walletId !== envelope.payerWalletId || authority.payerWalletId !== envelope.payerWalletId || wallet.verified !== true
    ) return denial("INVALID_PAYMENT_REQUEST");
    if (
      grant.status !== "ACTIVE" || grant.kind !== "OUTGOING_PAYMENT" || authority.usable !== true || authority.restrictionsVerified !== true ||
      typeof authority.snapshotId !== "string" || authority.snapshotId.length === 0 ||
      !validTimestamp(authority.observedAtEpochMs) || !validTimestamp(authority.validUntilEpochMs) ||
      authority.observedAtEpochMs > nowEpochMs || authority.validUntilEpochMs <= nowEpochMs || authority.validUntilEpochMs > grant.validUntilEpochMs ||
      grant.revocationVersion !== envelope.grantRevocationVersion ||
      envelope.validFromEpochMs < grant.validFromEpochMs || envelope.validUntilEpochMs > grant.validUntilEpochMs
    ) return denial("GRANT_REAUTHORIZATION_REQUIRED");
    if (
      device.active !== true || device.ownerUserId !== envelope.ownerUserId || device.deviceId !== envelope.deviceId ||
      instruction.deviceId !== envelope.deviceId || device.keyVersion !== envelope.deviceKeyVersion ||
      instruction.keyVersion !== envelope.deviceKeyVersion || device.revocationVersion !== envelope.deviceRevocationVersion
    ) return denial("DEVICE_NOT_VERIFIED");
    if (
      merchant.verified !== true || typeof merchant.scopeId !== "string" || merchant.scopeId.length === 0 ||
      typeof merchant.walletId !== "string" || merchant.walletId.length === 0 ||
      (envelope.merchantScopeId !== undefined && envelope.merchantScopeId !== merchant.scopeId) ||
      (instruction.merchantScopeId !== undefined && instruction.merchantScopeId !== merchant.scopeId) ||
      (grant.merchantScopeId !== undefined && grant.merchantScopeId !== merchant.scopeId) ||
      (grant.receiverBindingId !== undefined && grant.receiverBindingId !== merchant.walletId)
    ) return denial("MERCHANT_NOT_VERIFIED");

    const signedLimit: Money = { value: instruction.maxDebitMinor, assetCode: instruction.assetCode, assetScale: instruction.assetScale };
    const amounts = [signedLimit, envelope.perPaymentMaxDebit, envelope.cumulativeCap, grant.perPaymentMaxDebit,
      grant.cumulativeCap, grant.cumulativeSpent, authority.cumulativeCap, authority.spentDebit,
      context.outstandingReservations, quote.payerDebit];
    if (
      amounts.some((amount) => !validMoney(amount)) || !validMoney(signedLimit, true) ||
      !validMoney(envelope.perPaymentMaxDebit, true) || !validMoney(envelope.cumulativeCap, true) ||
      !validMoney(grant.perPaymentMaxDebit, true) || !validMoney(grant.cumulativeCap, true) ||
      !validMoney(authority.cumulativeCap, true) || !validMoney(quote.payerDebit, true) ||
      amounts.some((amount) => !sameAsset(amount, signedLimit)) ||
      grant.payerAssetCode !== signedLimit.assetCode || grant.payerAssetScale !== signedLimit.assetScale ||
      !validMoney(quote.merchantReceive, true) || !validMoney(context.expectedMerchantReceive, true) ||
      !sameAsset(quote.merchantReceive, context.expectedMerchantReceive) ||
      quote.merchantReceive.value !== context.expectedMerchantReceive.value ||
      quote.merchantScopeId !== merchant.scopeId || quote.payerWalletId !== envelope.payerWalletId ||
      quote.receiverWalletId !== merchant.walletId || typeof quote.quoteId !== "string" || quote.quoteId.length === 0 ||
      !validTimestamp(quote.expiresAtEpochMs) || quote.expiresAtEpochMs <= nowEpochMs
    ) return denial("INVALID_PAYMENT_REQUEST");

    const signed = BigInt(signedLimit.value);
    const perPayment = BigInt(envelope.perPaymentMaxDebit.value);
    const grantPerPayment = BigInt(grant.perPaymentMaxDebit.value);
    const envelopeCap = BigInt(envelope.cumulativeCap.value);
    const grantCap = BigInt(grant.cumulativeCap.value);
    const providerCap = BigInt(authority.cumulativeCap.value);
    const grantSpent = BigInt(grant.cumulativeSpent.value);
    const providerSpent = BigInt(authority.spentDebit.value);
    if (perPayment > grantPerPayment || envelopeCap > grantCap || envelopeCap > providerCap || grantSpent > grantCap || providerSpent > providerCap) {
      return denial("GRANT_REAUTHORIZATION_REQUIRED");
    }
    if (signed > perPayment || signed > grantPerPayment || BigInt(quote.payerDebit.value) > signed) {
      return denial("OVER_TRANSACTION_CEILING");
    }
    // Reserve the signed ceiling, not just the quote, so a later quote cannot exceed it.
    const used = (grantSpent > providerSpent ? grantSpent : providerSpent) + BigInt(context.outstandingReservations.value);
    if (used + signed > envelopeCap || used + signed > grantCap || used + signed > providerCap) {
      return denial("CUMULATIVE_BUDGET_EXCEEDED");
    }
    return { allowed: true, maxPotentialDebit: { ...signedLimit } };
  } catch {
    return denial("INVALID_PAYMENT_REQUEST");
  }
}
