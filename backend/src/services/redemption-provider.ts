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
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    /* bare status for logs only; never the provider's text */
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
/** Closed, data-free classification of an unclear provider failure; never provider text. */
export type ProviderErrorKind =
  | "HTTP_5XX"
  | "HTTP_408"
  | "HTTP_4XX_VALIDATION"
  | "RESPONSE_VALIDATION"
  | "NETWORK"
  | "URL_NOT_ALLOWED"
  | "OTHER";
export interface ProviderErrorDetail {
  readonly errorKind: ProviderErrorKind;
  readonly httpStatus?: number;
}
/** We cannot tell what happened (timeout, 5xx, bad response): treat as UNKNOWN. */
export class ProviderUnknownError extends Error {
  constructor(
    message: string,
    readonly detail?: ProviderErrorDetail,
  ) {
    super(message);
  }
}

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

  /** Close an unpaid incoming payment at the merchant (best effort, after a failed attempt). */
  completeIncoming(args: { incomingPaymentId: string; merchantWalletAddress: string }): Promise<void>;

  /** Resolve a wallet address to its canonical id, asset and authorization server. */
  lookupWallet(address: string): Promise<WalletInfo>;

  /**
   * Start an INTERACTIVE outgoing-payment grant. The payer approves in the
   * wallet, which then redirects the browser to finishUri.
   */
  startOutgoingGrant(args: {
    wallet: WalletInfo;
    debitLimit: Money;
    finishUri: string;
    clientNonce: string;
  }): Promise<StartedGrant>;

  /**
   * Continue the grant after a VERIFIED callback and validate what the provider
   * actually granted (scope, payer, debit cap). Throws if anything is off.
   */
  finishOutgoingGrant(args: {
    continuation: GrantContinuation;
    interactRef: string;
    wallet: WalletInfo;
    requestedDebit: Money;
  }): Promise<FinishedGrant>;
}

export interface WalletInfo {
  readonly id: string;
  readonly assetCode: string;
  readonly assetScale: number;
  readonly authServer: string;
}

export interface GrantContinuation {
  readonly uri: string;
  readonly accessToken: string;
}

export interface StartedGrant {
  readonly redirectUrl: string;
  /** provider nonce for the callback hash */
  readonly providerNonce: string;
  /** the exact URL the grant request was sent to (part of the callback hash) */
  readonly grantRequestUrl: string;
  readonly continuation: GrantContinuation;
}

export interface FinishedGrant {
  readonly authority: OutgoingAuthority;
  readonly continuation: GrantContinuation;
  /** the provider's own returned cap (may be narrower than requested) */
  readonly grantedDebit: Money;
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
