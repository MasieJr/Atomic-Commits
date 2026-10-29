/*
 * The provider boundary for offline redemption. The redemption service only
 * talks to this interface, so its money rules (claims, budgets, idempotency,
 * UNKNOWN handling) can be tested without a live wallet, and the live adapter
 * (open-payments-redemption-provider.ts) stays a thin translation layer.
 */

/** Exact integer minor units as a string, e.g. { value: "186", "ZAR", 2 } = R1.86. */
export interface Money {
  readonly value: string;
  readonly assetCode: string;
  readonly assetScale: number;
}

export interface PreparedQuote {
  readonly incomingPaymentId: string;
  readonly quoteId: string;
  /** What the PAYER will be debited (payer asset). Limits are checked on this. */
  readonly debit: Money;
  /** What the MERCHANT receives (merchant asset). */
  readonly receive: Money;
  readonly expiresAtEpochMs?: number;
}

/** The live outgoing-payment authority, decrypted only for the duration of a call. */
export interface OutgoingAuthority {
  readonly accessToken: string;
  readonly manageUrl?: string;
  readonly expiresAtEpochMs?: number;
}

export type ProviderOutcome =
  | { readonly kind: "SUCCEEDED"; readonly sent: Money; readonly received: Money }
  | { readonly kind: "FAILED" }
  | { readonly kind: "PENDING" };

/** The provider definitely refused (4xx, not a timeout): nothing was debited. */
export class ProviderRejectedError extends Error {}
/** We cannot tell what happened (timeout, 5xx, bad response): treat as UNKNOWN. */
export class ProviderUnknownError extends Error {}

export interface RedemptionProvider {
  /** Create a fresh incoming payment at the merchant and a quote from the payer. */
  prepareQuote(args: {
    payerWalletAddress: string;
    merchantWalletAddress: string;
    merchantReceive: Money;
    reference: string;
  }): Promise<PreparedQuote>;

  /**
   * Submit the outgoing payment EXACTLY ONCE. Must throw ProviderRejectedError
   * only for a definite refusal; anything unclear is ProviderUnknownError.
   * Must never retry internally.
   */
  submitPayment(args: {
    payerWalletAddress: string;
    quoteId: string;
    authority: OutgoingAuthority;
  }): Promise<{ outgoingPaymentId: string }>;

  /** Read-only status check. Never submits anything. */
  readOutcome(args: {
    outgoingPaymentId: string;
    incomingPaymentId: string;
    merchantWalletAddress: string;
    expectedDebit: Money;
    authority: OutgoingAuthority;
  }): Promise<ProviderOutcome>;

  /** Rotate the access token in place. Never asks the payer for new consent. */
  rotateAuthority(authority: OutgoingAuthority): Promise<OutgoingAuthority>;

  /**
   * Read-only recovery after a crash mid-submit: find the outgoing payment (if
   * any) created from this quote. undefined = provider has no such payment.
   * Throws when the provider can't be asked; the caller then stays UNKNOWN.
   */
  findOutgoingByQuote(args: {
    payerWalletAddress: string;
    quoteId: string;
    authority: OutgoingAuthority;
  }): Promise<{ outgoingPaymentId: string } | undefined>;

  /** Cancel the payer's grant at the provider (revocation). */
  cancelGrant(continuation: { uri: string; accessToken: string }): Promise<void>;
}

const MINOR_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

export function parseMinor(value: unknown): bigint | undefined {
  return typeof value === "string" && MINOR_PATTERN.test(value) ? BigInt(value) : undefined;
}

export function isMoney(value: unknown): value is Money {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const money = value as Record<string, unknown>;
  return (
    parseMinor(money.value) !== undefined &&
    typeof money.assetCode === "string" &&
    /^[A-Z]{3,12}$/.test(money.assetCode) &&
    typeof money.assetScale === "number" &&
    Number.isInteger(money.assetScale) &&
    money.assetScale >= 0 &&
    money.assetScale <= 18
  );
}

export function sameAsset(a: Money, b: { assetCode: string; assetScale: number }): boolean {
  return a.assetCode === b.assetCode && a.assetScale === b.assetScale;
}
