import { createHash } from "node:crypto";

import { PaymentEngineError, isPaymentEngineErrorCode, type PaymentEngineErrorCode } from "./errors";
import type { GrantAuthorization } from "./grants";
import { isValidMoney, sameAsset, type Money } from "./money";
import { offlineRedemptionFingerprint, verifyOfflineInstruction } from "./offline-redemption";
import {
  evaluateOfflinePreQuotePolicy,
  evaluateOfflineSpendingPolicy,
  type OfflineDeviceEnrollment,
  type OfflinePolicyContext,
  type OfflinePreQuoteContext,
  type OfflineProviderAuthority,
} from "./offline-spending-policy";
import { isPaymentStatus, isValidUserId, type PaymentResult, type UserId } from "./payments";
import { canonicalize, canonicalUtf8Bytes } from "./serialization";
import type { OfflineInstructionV1 } from "./signed-offline-instruction";

/** Trusted, server-loaded state. The API must authenticate the actor before calling this service. */
export interface OnlineExecutionContext {
  readonly grant: GrantAuthorization;
  readonly authority: OfflineProviderAuthority;
  readonly wallet: { readonly ownerUserId: UserId; readonly walletId: string; readonly verified: boolean };
  readonly merchant: { readonly scopeId: string; readonly walletId: string; readonly verified: boolean };
  /** Pending reservations other than the claim explicitly excluded by the loader. */
  readonly outstandingReservations: Money;
}

export interface ExecuteOnlinePurchase {
  readonly userId: UserId;
  readonly idempotencyKey: string;
  readonly authorizationId: string;
  readonly merchantScopeId: string;
  readonly merchantReceive: Money;
  readonly maxPayerDebit?: Money;
}

/** `merchantScopeId` comes from the authenticated merchant, never from the signed voucher. */
export interface ExecuteSignedOfflinePurchase {
  readonly instruction: unknown;
  readonly merchantScopeId: string;
  readonly merchantReceive: Money;
}

/** Immutable provider quote and resources; all payer amounts are in payer-debit units. */
export interface ExecutionQuote {
  readonly quoteId: string;
  readonly incomingPaymentId: string;
  readonly payerWalletId: string;
  readonly merchantScopeId: string;
  readonly merchantWalletId: string;
  readonly payerDebit: Money;
  readonly merchantReceive: Money;
  readonly expiresAtEpochMs: number;
}

/** Storage-created, durable ownership of a reserved amount and a single attempt. */
export interface ExecutionClaim {
  readonly paymentId: string;
  readonly attemptId: string;
  readonly ownerUserId: UserId;
  readonly authorizationId: string;
  readonly payerWalletId: string;
  readonly merchantScopeId: string;
  readonly merchantWalletId: string;
  readonly snapshotId: string;
  readonly requestFingerprint: string;
  readonly merchantReceive: Money;
  readonly reservedMaximum: Money;
  readonly freshGrantEmpty: boolean;
}

export interface ExecutionClaimRequest {
  readonly kind: "ONLINE" | "OFFLINE";
  readonly ownerUserId: UserId;
  readonly authorizationId: string;
  readonly payerWalletId: string;
  readonly merchantScopeId: string;
  readonly merchantWalletId: string;
  readonly snapshotId: string;
  readonly merchantReceive: Money;
  readonly maximumDebit: Money;
  readonly requestFingerprint: string;
  readonly freshGrantEmpty: boolean;
  readonly idempotencyKey?: string;
  readonly offline?: {
    readonly envelopeId: string;
    readonly instructionId: string;
    readonly nonce: string;
    readonly deviceId: string;
    readonly keyVersion: string;
    readonly deviceRevocationVersion: number;
    readonly grantRevocationVersion: number;
    readonly instructionExpiresAtEpochMs: number;
  };
}

export type ExecutionClaimOutcome =
  | { readonly kind: "CLAIMED"; readonly claim: ExecutionClaim }
  | { readonly kind: "PREVIOUS"; readonly ownerUserId: UserId; readonly requestFingerprint: string; readonly stored: StoredExecution }
  | { readonly kind: "REJECTED"; readonly code: PaymentEngineErrorCode }
  | { readonly kind: "UNKNOWN" };

/** A finalized provider outcome requires independently verified resource state. */
export type ProviderExecutionObservation =
  | { readonly kind: "CONFIRMED"; readonly providerAttemptRef: string; readonly payerDebit: Money; readonly merchantReceive: Money }
  | { readonly kind: "NO_DEBIT"; readonly providerAttemptRef?: string }
  | { readonly kind: "PROCESSING"; readonly providerAttemptRef: string }
  | { readonly kind: "UNKNOWN"; readonly providerAttemptRef?: string };

export interface StoredExecution {
  readonly claim: ExecutionClaim;
  readonly quote?: ExecutionQuote;
  readonly result: PaymentResult;
  readonly providerAttemptRef?: string;
  /** Conservative lower bound for post-payment reconciliation, not a provider observation. */
  readonly minimumSpentBefore?: Money;
  readonly aggregateCap?: Money;
  readonly confirmedSpentCounter?: Money;
  /** True only after a verified zero-debit outcome or a definite pre-submit rejection. */
  readonly noDebitConfirmed?: boolean;
}

export interface PaymentExecutionSnapshots {
  loadDeviceEnrollment(envelopeId: string, deviceId: string, keyVersion: string): Promise<OfflineDeviceEnrollment | undefined>;
  loadOfflineContext(envelopeId: string, merchantScopeId: string, excludeAttemptId?: string): Promise<OfflinePreQuoteContext | undefined>;
  loadOnlineContext(userId: UserId, authorizationId: string, merchantScopeId: string, excludeAttemptId?: string): Promise<OnlineExecutionContext | undefined>;
}

/**
 * These operations must be backed by durable transactions, not process-local locks.
 * Implementations re-read the owner, merchant, device, grant, authority snapshot,
 * revocation versions, expiry, budget and outstanding reservations atomically.
 * A fresh null/null grant can have at most one claim until its numeric counter is
 * reconciled. Offline nonces stay consumed even after a pre-submit rejection.
 */
export interface PaymentExecutionStore {
  /** Owner-scoped idempotency lookup; a later claim must still atomically recheck it. */
  findOnline(input: { readonly userId: UserId; readonly idempotencyKey: string; readonly requestFingerprint: string }): Promise<
    | { readonly kind: "PREVIOUS"; readonly ownerUserId: UserId; readonly requestFingerprint: string; readonly stored: StoredExecution }
    | { readonly kind: "CONFLICT" }
    | { readonly kind: "NOT_FOUND" }
    | { readonly kind: "UNKNOWN" }
  >;
  /** Atomically create the attempt, consume its nonce or idempotency key and reserve budget. */
  claim(request: ExecutionClaimRequest): Promise<ExecutionClaimOutcome>;
  /**
   * Atomically revalidate the reservation and fresh quote, persist all provider
   * resource IDs and transition RESERVED -> SUBMITTING. Only one caller may
   * receive STARTED. REFUSED proves this claim is still safely rejectable and
   * no other caller acquired submission; an uncertain commit or competing
   * submission must return UNKNOWN or throw.
   */
  beginSubmission(input: { readonly claim: ExecutionClaim; readonly quote: ExecutionQuote; readonly minimumSpentBefore: Money; readonly aggregateCap: Money }): Promise<"STARTED" | "REFUSED" | "UNKNOWN">;
  /**
   * Atomically record rejection/outbox and release budget only when this caller
   * has not invoked the provider. An offline nonce remains permanently consumed.
   */
  rejectBeforeSubmission(input: { readonly claim: ExecutionClaim; readonly code: PaymentEngineErrorCode }): Promise<"REJECTED" | "UNKNOWN">;
  /**
   * Atomically persist the result, provider reference and notification-outbox
   * event. UNKNOWN/PROCESSING retain the reservation; only confirmed no-debit
   * failure releases it, and confirmed success records the paid amount.
   * A compatible existing terminal result returns PREVIOUS with its evidence.
   * A conflicting terminal observation must atomically record a dispute, block
   * the grant, retain or reinstate the reservation conservatively, and return
   * UNKNOWN; subsequent loads show UNKNOWN while retaining the terminal audit.
   */
  recordOutcome(input: {
    readonly claim: ExecutionClaim;
    readonly result: PaymentResult;
    readonly providerAttemptRef?: string;
    readonly confirmedSpentCounter?: Money;
    readonly noDebitConfirmed?: true;
  }): Promise<{ readonly kind: "RECORDED" } | { readonly kind: "PREVIOUS"; readonly stored: StoredExecution } | { readonly kind: "UNKNOWN" }>;
  /** Owner-scoped load. A foreign owner's payment must appear absent. */
  loadExecution(userId: UserId, paymentId: string): Promise<StoredExecution | undefined>;
}

export interface PaymentExecutionProvider {
  /** Create an incoming payment and a fresh quote; this operation must not submit a debit. */
  createQuote(input: { readonly claim: ExecutionClaim; readonly merchantReceive: Money }): Promise<ExecutionQuote>;
  /** Single attempt only. A timeout or malformed response must not cause a retry. */
  submitOnce(input: { readonly claim: ExecutionClaim; readonly quote: ExecutionQuote }): Promise<ProviderExecutionObservation>;
  /** Read-only reconciliation using the original reference; never submit another debit. */
  readPayment(input: { readonly claim: ExecutionClaim; readonly quote: ExecutionQuote; readonly providerAttemptRef: string }): Promise<ProviderExecutionObservation>;
  /** Current numeric provider counter; null/malformed values are never assumed to be zero. */
  readSpentCounter(input: { readonly claim: ExecutionClaim }): Promise<Money | null>;
}

export interface PaymentExecutionPorts {
  readonly snapshots: PaymentExecutionSnapshots;
  readonly store: PaymentExecutionStore;
  readonly provider: PaymentExecutionProvider;
  nowEpochMs(): number;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && /^[\x21-\x7e]+$/.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validAmount(value: unknown, positive = false): value is Money {
  return isValidMoney(value) && value.value.length <= 18 && (!positive || value.value !== "0");
}

function copyAmount(value: Money): Money {
  return { value: value.value, assetCode: value.assetCode, assetScale: value.assetScale };
}

function sameAmount(left: Money, right: Money): boolean {
  return validAmount(left) && validAmount(right) && sameAsset(left, right) && left.value === right.value;
}

function now(ports: PaymentExecutionPorts): number {
  const value = ports.nowEpochMs();
  if (!validTime(value)) throw new PaymentEngineError("INVALID_PAYMENT_REQUEST");
  return value;
}

interface OnlineDecision {
  readonly maximumDebit: Money;
  readonly transactionLimit: Money;
  readonly remainingDebit: Money;
  readonly freshGrantEmpty: boolean;
}

function onlineDecision(command: ExecuteOnlinePurchase, context: OnlineExecutionContext, at: number): OnlineDecision {
  const { grant, authority, wallet, merchant, outstandingReservations } = context;
  if (!grant || !authority || !wallet || !merchant || !isValidUserId(command.userId) ||
      grant.userId !== command.userId || grant.authorizationId !== command.authorizationId ||
      authority.authorizationId !== command.authorizationId || authority.ownerUserId !== command.userId ||
      wallet.ownerUserId !== command.userId || wallet.verified !== true || wallet.walletId !== authority.payerWalletId ||
      !identifier(wallet.walletId) || !identifier(grant.authorityRef)) throw new PaymentEngineError("GRANT_INVALID");
  if (merchant.verified !== true || merchant.scopeId !== command.merchantScopeId || !identifier(merchant.walletId) ||
      (grant.merchantScopeId !== undefined && grant.merchantScopeId !== merchant.scopeId) ||
      (grant.receiverBindingId !== undefined && grant.receiverBindingId !== merchant.walletId)) throw new PaymentEngineError("MERCHANT_NOT_VERIFIED");
  if (grant.status !== "ACTIVE" || grant.kind !== "OUTGOING_PAYMENT" || authority.usable !== true || authority.restrictionsVerified !== true ||
      !identifier(authority.snapshotId) || !validTime(grant.validFromEpochMs) || !validTime(grant.validUntilEpochMs) ||
      !validTime(authority.observedAtEpochMs) || !validTime(authority.validUntilEpochMs) ||
      grant.validFromEpochMs >= grant.validUntilEpochMs || at < grant.validFromEpochMs || at >= grant.validUntilEpochMs ||
      authority.observedAtEpochMs > at || authority.validUntilEpochMs <= at || authority.validUntilEpochMs > grant.validUntilEpochMs ||
      !Number.isSafeInteger(grant.revocationVersion) || grant.revocationVersion < 0) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  const amounts = [grant.perPaymentMaxDebit, grant.cumulativeCap, grant.cumulativeSpent, authority.cumulativeCap, outstandingReservations,
    ...(authority.spentDebit === null ? [] : [authority.spentDebit]), ...(command.maxPayerDebit === undefined ? [] : [command.maxPayerDebit])];
  if (amounts.some((amount) => !validAmount(amount)) || !validAmount(grant.perPaymentMaxDebit, true) ||
      !validAmount(grant.cumulativeCap, true) || !validAmount(authority.cumulativeCap, true) ||
      (command.maxPayerDebit !== undefined && !validAmount(command.maxPayerDebit, true)) ||
      amounts.some((amount) => !sameAsset(amount, grant.cumulativeCap)) ||
      grant.payerAssetCode !== grant.cumulativeCap.assetCode || grant.payerAssetScale !== grant.cumulativeCap.assetScale) {
    throw new PaymentEngineError("INVALID_MONEY");
  }
  const freshGrantEmpty = authority.spentDebit === null;
  if (freshGrantEmpty && (authority.freshGrantEmpty !== true || grant.cumulativeSpent.value !== "0" || outstandingReservations.value !== "0")) {
    throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  }
  const cap = BigInt(grant.cumulativeCap.value);
  const providerCap = BigInt(authority.cumulativeCap.value);
  const localSpent = BigInt(grant.cumulativeSpent.value);
  const providerSpent = freshGrantEmpty ? 0n : BigInt(authority.spentDebit!.value);
  if (cap > providerCap || localSpent > cap || providerSpent > providerCap || BigInt(grant.perPaymentMaxDebit.value) > cap) {
    throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  }
  const used = (localSpent > providerSpent ? localSpent : providerSpent) + BigInt(outstandingReservations.value);
  if (used >= cap) throw new PaymentEngineError("CUMULATIVE_BUDGET_EXCEEDED");
  let transactionLimit = BigInt(grant.perPaymentMaxDebit.value);
  if (command.maxPayerDebit !== undefined && transactionLimit > BigInt(command.maxPayerDebit.value)) transactionLimit = BigInt(command.maxPayerDebit.value);
  let maximum = transactionLimit;
  const remaining = cap - used;
  if (maximum > remaining) maximum = remaining;
  return {
    maximumDebit: { ...copyAmount(grant.cumulativeCap), value: maximum.toString() },
    transactionLimit: { ...copyAmount(grant.cumulativeCap), value: transactionLimit.toString() },
    remainingDebit: { ...copyAmount(grant.cumulativeCap), value: remaining.toString() },
    freshGrantEmpty,
  };
}

function onlineFingerprint(command: ExecuteOnlinePurchase): string {
  const bytes = canonicalUtf8Bytes(canonicalize({ version: "1", body: {
    purpose: "atomic-commits/online-payment", userId: command.userId, authorizationId: command.authorizationId,
    merchantScopeId: command.merchantScopeId, merchantReceive: { ...command.merchantReceive },
    ...(command.maxPayerDebit === undefined ? {} : { maxPayerDebit: { ...command.maxPayerDebit } }),
  } }));
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizedResult(result: PaymentResult, expectedReceive?: Money): PaymentResult | undefined {
  if (!result || !identifier(result.paymentId) || !identifier(result.attemptId) || !isPaymentStatus(result.status) ||
      (result.failureCode !== undefined && !isPaymentEngineErrorCode(result.failureCode)) ||
      (result.resolvedAtEpochMs !== undefined && !validTime(result.resolvedAtEpochMs))) return undefined;
  if (result.status === "SUCCEEDED") {
    if (!validAmount(result.payerDebitPaid, true) || !validAmount(result.merchantReceivePaid, true) ||
        result.failureCode !== undefined || (expectedReceive && !sameAmount(result.merchantReceivePaid, expectedReceive))) return undefined;
  } else if (result.payerDebitPaid !== undefined || result.merchantReceivePaid !== undefined) {
    return undefined;
  }
  return {
    paymentId: result.paymentId, attemptId: result.attemptId, status: result.status,
    ...(result.payerDebitPaid ? { payerDebitPaid: copyAmount(result.payerDebitPaid) } : {}),
    ...(result.merchantReceivePaid ? { merchantReceivePaid: copyAmount(result.merchantReceivePaid) } : {}),
    ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    ...(result.resolvedAtEpochMs === undefined ? {} : { resolvedAtEpochMs: result.resolvedAtEpochMs }),
  };
}

function counterMatches(
  claim: ExecutionClaim, quote: ExecutionQuote, minimum: Money, cap: Money, counter: unknown,
): counter is Money {
  if (!validAmount(minimum) || !validAmount(cap, true) || !validAmount(counter) ||
      !sameAsset(minimum, cap) || !sameAsset(quote.payerDebit, cap) || !sameAsset(counter, cap)) return false;
  const expected = BigInt(minimum.value) + BigInt(quote.payerDebit.value);
  const actual = BigInt(counter.value);
  return expected <= BigInt(cap.value) && actual >= expected && actual <= BigInt(cap.value) &&
    (!claim.freshGrantEmpty || (minimum.value === "0" && actual === BigInt(quote.payerDebit.value)));
}

function trustedStoredResult(stored: StoredExecution, ownerUserId: UserId, expectedFingerprint?: string, expectedReceive?: Money): PaymentResult | undefined {
  try {
    const claim = stored?.claim;
    const result = sanitizedResult(stored?.result, expectedReceive);
    if (!claim || claim.ownerUserId !== ownerUserId || !identifier(claim.paymentId) || !identifier(claim.attemptId) ||
        !identifier(claim.authorizationId) || !identifier(claim.payerWalletId) || !identifier(claim.merchantScopeId) ||
        !identifier(claim.merchantWalletId) || !identifier(claim.snapshotId) || typeof claim.requestFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(claim.requestFingerprint) || (expectedFingerprint !== undefined && claim.requestFingerprint !== expectedFingerprint) ||
        !validAmount(claim.merchantReceive, true) || (expectedReceive !== undefined && !sameAmount(claim.merchantReceive, expectedReceive)) ||
        !validAmount(claim.reservedMaximum, true) || typeof claim.freshGrantEmpty !== "boolean" || !result ||
        result.paymentId !== claim.paymentId || result.attemptId !== claim.attemptId) return undefined;
    if (result.status === "SUCCEEDED") {
      const quote = stored.quote;
      if (!quote || !quoteIsUsable(quote, claim, claim.merchantReceive, 0) || !identifier(stored.providerAttemptRef) ||
          !stored.minimumSpentBefore || !stored.aggregateCap ||
          !counterMatches(claim, quote, stored.minimumSpentBefore, stored.aggregateCap, stored.confirmedSpentCounter) ||
          !result.payerDebitPaid || !result.merchantReceivePaid || !sameAmount(result.payerDebitPaid, quote.payerDebit) ||
          !sameAmount(result.merchantReceivePaid, quote.merchantReceive)) return undefined;
    }
    if ((result.status === "FAILED" || result.status === "REJECTED") && stored.noDebitConfirmed !== true) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

function unknownResult(claim: ExecutionClaim): PaymentResult {
  return { paymentId: claim.paymentId, attemptId: claim.attemptId, status: "UNKNOWN", failureCode: "PAYMENT_OUTCOME_UNKNOWN" };
}

function validClaim(claim: ExecutionClaim, request: ExecutionClaimRequest): boolean {
  return !!claim && identifier(claim.paymentId) && identifier(claim.attemptId) &&
    claim.ownerUserId === request.ownerUserId && claim.authorizationId === request.authorizationId &&
    claim.payerWalletId === request.payerWalletId && claim.merchantScopeId === request.merchantScopeId &&
    claim.merchantWalletId === request.merchantWalletId && claim.snapshotId === request.snapshotId &&
    claim.requestFingerprint === request.requestFingerprint && sameAmount(claim.merchantReceive, request.merchantReceive) &&
    claim.freshGrantEmpty === request.freshGrantEmpty && validAmount(claim.reservedMaximum, true) &&
    sameAsset(claim.reservedMaximum, request.maximumDebit) && BigInt(claim.reservedMaximum.value) <= BigInt(request.maximumDebit.value);
}

function copyClaim(claim: ExecutionClaim): ExecutionClaim {
  return Object.freeze({
    paymentId: claim.paymentId, attemptId: claim.attemptId, ownerUserId: claim.ownerUserId,
    authorizationId: claim.authorizationId, payerWalletId: claim.payerWalletId,
    merchantScopeId: claim.merchantScopeId, merchantWalletId: claim.merchantWalletId,
    snapshotId: claim.snapshotId, requestFingerprint: claim.requestFingerprint, merchantReceive: Object.freeze(copyAmount(claim.merchantReceive)),
    reservedMaximum: Object.freeze(copyAmount(claim.reservedMaximum)), freshGrantEmpty: claim.freshGrantEmpty,
  });
}

async function claimPurchase(
  request: ExecutionClaimRequest,
  receive: Money,
  store: PaymentExecutionStore,
): Promise<{ claim: ExecutionClaim } | { result: PaymentResult }> {
  const expected: ExecutionClaimRequest = Object.freeze({
    ...request,
    merchantReceive: Object.freeze(copyAmount(request.merchantReceive)),
    maximumDebit: Object.freeze(copyAmount(request.maximumDebit)),
    ...(request.offline === undefined ? {} : { offline: Object.freeze({ ...request.offline }) }),
  });
  let outcome: ExecutionClaimOutcome;
  try { outcome = await store.claim(expected); } catch { throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN"); }
  if (!outcome || outcome.kind === "UNKNOWN") throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
  if (outcome.kind === "REJECTED") {
    throw new PaymentEngineError(isPaymentEngineErrorCode(outcome.code) ? outcome.code : "PAYMENT_OUTCOME_UNKNOWN");
  }
  if (outcome.kind === "PREVIOUS") {
    if (outcome.ownerUserId !== expected.ownerUserId || outcome.requestFingerprint !== expected.requestFingerprint) {
      throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    }
    const result = trustedStoredResult(outcome.stored, expected.ownerUserId, expected.requestFingerprint, receive);
    if (!result) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    return { result };
  }
  if (outcome.kind !== "CLAIMED" || !validClaim(outcome.claim, expected)) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
  return { claim: copyClaim(outcome.claim) };
}

function quoteIsUsable(quote: ExecutionQuote, claim: ExecutionClaim, receive: Money, at: number): boolean {
  return !!quote && identifier(quote.quoteId) && identifier(quote.incomingPaymentId) &&
    quote.payerWalletId === claim.payerWalletId && quote.merchantScopeId === claim.merchantScopeId &&
    quote.merchantWalletId === claim.merchantWalletId && validAmount(quote.payerDebit, true) &&
    sameAsset(quote.payerDebit, claim.reservedMaximum) && BigInt(quote.payerDebit.value) <= BigInt(claim.reservedMaximum.value) &&
    validAmount(quote.merchantReceive, true) && sameAmount(quote.merchantReceive, receive) && sameAmount(quote.merchantReceive, claim.merchantReceive) &&
    validTime(quote.expiresAtEpochMs) && quote.expiresAtEpochMs > at;
}

function copyQuote(quote: ExecutionQuote): ExecutionQuote {
  return Object.freeze({
    quoteId: quote.quoteId, incomingPaymentId: quote.incomingPaymentId, payerWalletId: quote.payerWalletId,
    merchantScopeId: quote.merchantScopeId, merchantWalletId: quote.merchantWalletId,
    payerDebit: Object.freeze(copyAmount(quote.payerDebit)), merchantReceive: Object.freeze(copyAmount(quote.merchantReceive)), expiresAtEpochMs: quote.expiresAtEpochMs,
  });
}

interface SubmissionValidation {
  readonly minimumSpentBefore: Money;
  readonly aggregateCap: Money;
  readonly validUntilEpochMs: number;
}

function submissionValidation(grant: GrantAuthorization, authority: OfflineProviderAuthority, claim: ExecutionClaim, validUntil: number): SubmissionValidation {
  if (!validAmount(grant.cumulativeSpent) || !validAmount(grant.cumulativeCap, true) ||
      !sameAsset(grant.cumulativeSpent, grant.cumulativeCap) || !sameAsset(grant.cumulativeCap, claim.reservedMaximum) ||
      authority.snapshotId !== claim.snapshotId || authority.authorizationId !== claim.authorizationId ||
      authority.ownerUserId !== claim.ownerUserId || authority.payerWalletId !== claim.payerWalletId ||
      !validTime(validUntil)) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  if (authority.spentDebit === null && (!claim.freshGrantEmpty || authority.freshGrantEmpty !== true)) {
    throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  }
  if (authority.spentDebit !== null && (!validAmount(authority.spentDebit) || !sameAsset(authority.spentDebit, grant.cumulativeCap))) {
    throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  }
  const localSpent = BigInt(grant.cumulativeSpent.value);
  const providerSpent = authority.spentDebit === null ? 0n : BigInt(authority.spentDebit.value);
  // The null/null bootstrap is allowed only for an isolated claim; this bound
  // is used for subsequent reconciliation and is not a numeric provider reading.
  if (claim.freshGrantEmpty && (localSpent !== 0n || providerSpent !== 0n)) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  return Object.freeze({
    minimumSpentBefore: Object.freeze({ ...copyAmount(grant.cumulativeCap), value: (localSpent > providerSpent ? localSpent : providerSpent).toString() }),
    aggregateCap: Object.freeze(copyAmount(grant.cumulativeCap)),
    validUntilEpochMs: validUntil,
  });
}

async function rejectBeforeSubmission(claim: ExecutionClaim, code: PaymentEngineErrorCode, store: PaymentExecutionStore): Promise<PaymentResult> {
  try {
    if (await store.rejectBeforeSubmission({ claim, code }) !== "REJECTED") return unknownResult(claim);
    return { paymentId: claim.paymentId, attemptId: claim.attemptId, status: "REJECTED", failureCode: code };
  } catch {
    return unknownResult(claim);
  }
}

async function recordOutcome(
  claim: ExecutionClaim,
  result: PaymentResult,
  ports: PaymentExecutionPorts,
  providerAttemptRef?: string,
  confirmedSpentCounter?: Money,
  noDebitConfirmed?: true,
): Promise<PaymentResult> {
  const fixedResult: PaymentResult = Object.freeze({
    ...result,
    ...(result.payerDebitPaid === undefined ? {} : { payerDebitPaid: Object.freeze(copyAmount(result.payerDebitPaid)) }),
    ...(result.merchantReceivePaid === undefined ? {} : { merchantReceivePaid: Object.freeze(copyAmount(result.merchantReceivePaid)) }),
  });
  try {
    const recorded = await ports.store.recordOutcome({ claim, result: fixedResult,
      ...(providerAttemptRef === undefined ? {} : { providerAttemptRef }),
      ...(confirmedSpentCounter === undefined ? {} : { confirmedSpentCounter: copyAmount(confirmedSpentCounter) }),
      ...(noDebitConfirmed === undefined ? {} : { noDebitConfirmed }),
    });
    if (recorded?.kind === "RECORDED") return fixedResult;
    if (recorded?.kind === "PREVIOUS") {
      const previous = trustedStoredResult(recorded.stored, claim.ownerUserId, claim.requestFingerprint, claim.merchantReceive);
      if (previous && previous.paymentId === claim.paymentId && previous.attemptId === claim.attemptId &&
          ["SUCCEEDED", "FAILED", "REJECTED"].includes(previous.status)) {
        if (["SUCCEEDED", "FAILED", "REJECTED"].includes(fixedResult.status) && previous.status !== fixedResult.status) return unknownResult(claim);
        return previous;
      }
    }
    return unknownResult(claim);
  } catch {
    // SUBMITTING is already durable; never submit again after a failed write.
    return unknownResult(claim);
  }
}

async function applyProviderObservation(
  claim: ExecutionClaim,
  quote: ExecutionQuote,
  validation: SubmissionValidation,
  observation: ProviderExecutionObservation,
  ports: PaymentExecutionPorts,
): Promise<PaymentResult> {
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    return recordOutcome(claim, unknownResult(claim), ports);
  }
  const reference = "providerAttemptRef" in observation && identifier(observation.providerAttemptRef)
    ? observation.providerAttemptRef : undefined;
  if ("providerAttemptRef" in observation && observation.providerAttemptRef !== undefined && reference === undefined) {
    return recordOutcome(claim, unknownResult(claim), ports);
  }
  if (observation.kind === "UNKNOWN" || (observation.kind === "PROCESSING" && reference === undefined)) {
    return recordOutcome(claim, unknownResult(claim), ports, reference);
  }
  if (observation.kind === "PROCESSING") {
    return recordOutcome(claim, { paymentId: claim.paymentId, attemptId: claim.attemptId, status: "PROCESSING" }, ports, reference);
  }
  if (observation.kind === "NO_DEBIT") {
    return recordOutcome(claim, { paymentId: claim.paymentId, attemptId: claim.attemptId, status: "REJECTED", failureCode: "PROVIDER_PAYMENT_REJECTED" }, ports, reference, undefined, true);
  }
  if (observation.kind !== "CONFIRMED" || reference === undefined || !sameAmount(observation.payerDebit, quote.payerDebit) ||
      !sameAmount(observation.merchantReceive, quote.merchantReceive)) {
    return recordOutcome(claim, unknownResult(claim), ports, reference);
  }
  const confirmedDebit = copyAmount(observation.payerDebit);
  const confirmedReceive = copyAmount(observation.merchantReceive);
  let counter: Money | null;
  try { counter = await ports.provider.readSpentCounter({ claim }); } catch { return recordOutcome(claim, unknownResult(claim), ports, reference); }
  if (!counterMatches(claim, quote, validation.minimumSpentBefore, validation.aggregateCap, counter)) {
    return recordOutcome(claim, unknownResult(claim), ports, reference);
  }
  let resolvedAtEpochMs: number;
  try { resolvedAtEpochMs = now(ports); } catch { return recordOutcome(claim, unknownResult(claim), ports, reference); }
  return recordOutcome(claim, {
    paymentId: claim.paymentId, attemptId: claim.attemptId, status: "SUCCEEDED",
    payerDebitPaid: confirmedDebit, merchantReceivePaid: confirmedReceive, resolvedAtEpochMs,
  }, ports, reference, { value: counter.value, assetCode: counter.assetCode, assetScale: counter.assetScale });
}

async function executeClaim(
  claim: ExecutionClaim,
  receive: Money,
  ports: PaymentExecutionPorts,
  revalidate: (quote: ExecutionQuote, at: number) => Promise<SubmissionValidation>,
): Promise<PaymentResult> {
  let quote: ExecutionQuote;
  try {
    const candidate = await ports.provider.createQuote({ claim, merchantReceive: receive });
    if (!quoteIsUsable(candidate, claim, receive, now(ports))) throw new Error("Invalid quote.");
    quote = copyQuote(candidate);
  } catch {
    return rejectBeforeSubmission(claim, "QUOTE_UNAVAILABLE", ports.store);
  }
  let validation: SubmissionValidation;
  try {
    validation = await revalidate(quote, now(ports));
    const at = now(ports);
    if (!quoteIsUsable(quote, claim, receive, at) || at >= validation.validUntilEpochMs) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
  } catch (error) {
    return rejectBeforeSubmission(claim, error instanceof PaymentEngineError ? error.code : "GRANT_REAUTHORIZATION_REQUIRED", ports.store);
  }
  let submission: "STARTED" | "REFUSED" | "UNKNOWN";
  try {
    submission = await ports.store.beginSubmission({ claim, quote, minimumSpentBefore: validation.minimumSpentBefore, aggregateCap: validation.aggregateCap });
  } catch {
    return unknownResult(claim);
  }
  if (submission === "REFUSED") return rejectBeforeSubmission(claim, "GRANT_REAUTHORIZATION_REQUIRED", ports.store);
  if (submission !== "STARTED") return unknownResult(claim);
  try {
    const at = now(ports);
    if (!quoteIsUsable(quote, claim, receive, at) || at >= validation.validUntilEpochMs) {
      return rejectBeforeSubmission(claim, "GRANT_REAUTHORIZATION_REQUIRED", ports.store);
    }
  } catch {
    return rejectBeforeSubmission(claim, "GRANT_REAUTHORIZATION_REQUIRED", ports.store);
  }
  let observation: ProviderExecutionObservation;
  try { observation = await ports.provider.submitOnce({ claim, quote }); } catch { return recordOutcome(claim, unknownResult(claim), ports); }
  return applyProviderObservation(claim, quote, validation, observation, ports);
}

function deviceMatches(context: OfflinePreQuoteContext, enrollment: OfflineDeviceEnrollment): boolean {
  return !!context.device && context.device.active === true &&
    context.device.ownerUserId === enrollment.ownerUserId && context.device.deviceId === enrollment.deviceId &&
    context.device.keyVersion === enrollment.keyVersion && context.device.revocationVersion === enrollment.revocationVersion &&
    context.device.publicKey === enrollment.publicKey;
}

/**
 * Application-facing orchestration. It has no built-in storage, merchant auth or
 * provider credentials: production adapters must fulfill the contracts above.
 */
export class PaymentExecutionService {
  constructor(private readonly ports: PaymentExecutionPorts) {}

  async online(input: ExecuteOnlinePurchase): Promise<PaymentResult> {
    if (!input || !isValidUserId(input.userId) || !identifier(input.idempotencyKey) || !identifier(input.authorizationId) ||
        !identifier(input.merchantScopeId) || !validAmount(input.merchantReceive, true) ||
        (input.maxPayerDebit !== undefined && !validAmount(input.maxPayerDebit, true))) throw new PaymentEngineError("INVALID_PAYMENT_REQUEST");
    const command: ExecuteOnlinePurchase = Object.freeze({
      userId: input.userId, idempotencyKey: input.idempotencyKey, authorizationId: input.authorizationId,
      merchantScopeId: input.merchantScopeId,
      merchantReceive: Object.freeze({ value: input.merchantReceive.value, assetCode: input.merchantReceive.assetCode, assetScale: input.merchantReceive.assetScale }),
      ...(input.maxPayerDebit === undefined ? {} : { maxPayerDebit: Object.freeze({
        value: input.maxPayerDebit.value, assetCode: input.maxPayerDebit.assetCode, assetScale: input.maxPayerDebit.assetScale,
      }) }),
    });
    const requestFingerprint = onlineFingerprint(command);
    let prior: Awaited<ReturnType<PaymentExecutionStore["findOnline"]>>;
    try {
      prior = await this.ports.store.findOnline({ userId: command.userId, idempotencyKey: command.idempotencyKey, requestFingerprint });
    } catch {
      throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    }
    if (!prior || prior.kind === "UNKNOWN") throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    if (prior.kind === "CONFLICT") throw new PaymentEngineError("IDEMPOTENCY_CONFLICT");
    if (prior.kind === "PREVIOUS") {
      if (prior.ownerUserId !== command.userId || prior.requestFingerprint !== requestFingerprint) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
      const result = trustedStoredResult(prior.stored, command.userId, requestFingerprint, command.merchantReceive);
      if (!result) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
      return result;
    }
    if (prior.kind !== "NOT_FOUND") throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");

    let context: OnlineExecutionContext | undefined;
    try { context = await this.ports.snapshots.loadOnlineContext(command.userId, command.authorizationId, command.merchantScopeId); } catch { /* fail closed */ }
    if (!context) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
    const decision = onlineDecision(command, context, now(this.ports));
    const request: ExecutionClaimRequest = {
      kind: "ONLINE", ownerUserId: command.userId, authorizationId: command.authorizationId,
      payerWalletId: context.wallet.walletId, merchantScopeId: context.merchant.scopeId, merchantWalletId: context.merchant.walletId,
      snapshotId: context.authority.snapshotId, merchantReceive: copyAmount(command.merchantReceive), maximumDebit: copyAmount(decision.maximumDebit), requestFingerprint,
      freshGrantEmpty: decision.freshGrantEmpty, idempotencyKey: command.idempotencyKey,
    };
    const acquired = await claimPurchase(request, command.merchantReceive, this.ports.store);
    if ("result" in acquired) return acquired.result;
    const claim = acquired.claim;
    return executeClaim(claim, command.merchantReceive, this.ports, async (quote) => {
      const current = await this.ports.snapshots.loadOnlineContext(command.userId, command.authorizationId, command.merchantScopeId, claim.attemptId);
      if (!current || current.wallet.walletId !== claim.payerWalletId || current.merchant.walletId !== claim.merchantWalletId) {
        throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
      }
      const updated = onlineDecision(command, current, now(this.ports));
      if (!sameAsset(quote.payerDebit, updated.transactionLimit)) throw new PaymentEngineError("INVALID_MONEY");
      if (BigInt(quote.payerDebit.value) > BigInt(updated.transactionLimit.value)) throw new PaymentEngineError("OVER_TRANSACTION_CEILING");
      if (BigInt(quote.payerDebit.value) > BigInt(updated.remainingDebit.value)) throw new PaymentEngineError("CUMULATIVE_BUDGET_EXCEEDED");
      if (updated.freshGrantEmpty && !claim.freshGrantEmpty) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
      return submissionValidation(current.grant, current.authority, claim,
        Math.min(current.grant.validUntilEpochMs, current.authority.validUntilEpochMs, quote.expiresAtEpochMs));
    });
  }

  async redeemSigned(input: ExecuteSignedOfflinePurchase): Promise<PaymentResult> {
    if (!input || !identifier(input.merchantScopeId) || !validAmount(input.merchantReceive, true)) throw new PaymentEngineError("INVALID_PAYMENT_REQUEST");
    const merchantScopeId = input.merchantScopeId;
    const receive: Money = Object.freeze({ value: input.merchantReceive.value, assetCode: input.merchantReceive.assetCode, assetScale: input.merchantReceive.assetScale });
    const verified = await verifyOfflineInstruction(input.instruction, merchantScopeId, receive,
      (envelopeId, deviceId, keyVersion) => this.ports.snapshots.loadDeviceEnrollment(envelopeId, deviceId, keyVersion));
    if (verified.status !== "VERIFIED") throw new PaymentEngineError(verified.code);
    const instruction = verified.instruction.payload;
    let context: OfflinePreQuoteContext | undefined;
    try { context = await this.ports.snapshots.loadOfflineContext(instruction.envelopeId, merchantScopeId); } catch { /* fail closed */ }
    if (!context) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
    if (!context.merchant || context.merchant.scopeId !== merchantScopeId) throw new PaymentEngineError("MERCHANT_NOT_VERIFIED");
    if (!deviceMatches(context, verified.enrollment)) throw new PaymentEngineError("DEVICE_NOT_VERIFIED");
    const pre = evaluateOfflinePreQuotePolicy(instruction, { ...context, nowEpochMs: now(this.ports) });
    if (!pre.allowed) throw new PaymentEngineError(pre.code);
    const request: ExecutionClaimRequest = {
      kind: "OFFLINE", ownerUserId: context.envelope.ownerUserId, authorizationId: instruction.authorizationId,
      payerWalletId: context.wallet.walletId, merchantScopeId: context.merchant.scopeId, merchantWalletId: context.merchant.walletId,
      snapshotId: context.authority.snapshotId, merchantReceive: copyAmount(receive), maximumDebit: copyAmount(pre.maxPotentialDebit),
      requestFingerprint: offlineRedemptionFingerprint(instruction, merchantScopeId, receive),
      freshGrantEmpty: pre.requiresInitialCounterReconciliation === true,
      offline: {
        envelopeId: instruction.envelopeId, instructionId: instruction.instructionId, nonce: instruction.nonce,
        deviceId: instruction.deviceId, keyVersion: instruction.keyVersion,
        deviceRevocationVersion: context.envelope.deviceRevocationVersion,
        grantRevocationVersion: context.envelope.grantRevocationVersion,
        instructionExpiresAtEpochMs: instruction.expiresAtEpochMs,
      },
    };
    const acquired = await claimPurchase(request, receive, this.ports.store);
    if ("result" in acquired) return acquired.result;
    const claim = acquired.claim;
    return executeClaim(claim, receive, this.ports, async (quote) => {
      const current = await this.ports.snapshots.loadOfflineContext(instruction.envelopeId, merchantScopeId, claim.attemptId);
      if (!current || !deviceMatches(current, verified.enrollment) || current.envelope.ownerUserId !== claim.ownerUserId ||
          current.wallet.walletId !== claim.payerWalletId || current.merchant.scopeId !== claim.merchantScopeId ||
          current.merchant.walletId !== claim.merchantWalletId) throw new PaymentEngineError("DEVICE_NOT_VERIFIED");
      const currentAt = now(this.ports);
      const quoteContext: OfflinePolicyContext = {
        ...current, nowEpochMs: currentAt,
        quote: {
          quoteId: quote.quoteId, merchantScopeId: quote.merchantScopeId, payerWalletId: quote.payerWalletId,
          receiverWalletId: quote.merchantWalletId, payerDebit: quote.payerDebit,
          merchantReceive: quote.merchantReceive, expiresAtEpochMs: quote.expiresAtEpochMs,
        },
        expectedMerchantReceive: receive,
      };
      const decision = evaluateOfflineSpendingPolicy(instruction, quoteContext);
      if (!decision.allowed) throw new PaymentEngineError(decision.code);
      if (decision.requiresInitialCounterReconciliation && !claim.freshGrantEmpty) throw new PaymentEngineError("GRANT_REAUTHORIZATION_REQUIRED");
      return submissionValidation(current.grant, current.authority, claim,
        Math.min(current.grant.validUntilEpochMs, current.authority.validUntilEpochMs, current.envelope.validUntilEpochMs,
          instruction.expiresAtEpochMs, quote.expiresAtEpochMs));
    });
  }

  /** Owner-scoped status lookup; never invokes the provider. */
  async statusOf(userId: UserId, paymentId: string): Promise<PaymentResult> {
    if (!isValidUserId(userId) || !identifier(paymentId)) throw new PaymentEngineError("INVALID_PAYMENT_REQUEST");
    let stored: StoredExecution | undefined;
    try { stored = await this.ports.store.loadExecution(userId, paymentId); } catch { throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN"); }
    if (!stored || (stored.claim && stored.claim.ownerUserId !== userId)) throw new PaymentEngineError("PAYMENT_NOT_FOUND");
    const result = trustedStoredResult(stored, userId);
    if (!result || result.paymentId !== paymentId) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    return result;
  }

  /** Read-only provider reconciliation; never obtains a quote or submits another debit. */
  async reconcile(userId: UserId, paymentId: string): Promise<PaymentResult> {
    if (!isValidUserId(userId) || !identifier(paymentId)) throw new PaymentEngineError("INVALID_PAYMENT_REQUEST");
    let stored: StoredExecution | undefined;
    try { stored = await this.ports.store.loadExecution(userId, paymentId); } catch { throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN"); }
    if (!stored || (stored.claim && stored.claim.ownerUserId !== userId)) throw new PaymentEngineError("PAYMENT_NOT_FOUND");
    const result = trustedStoredResult(stored, userId);
    if (!result || result.paymentId !== paymentId) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    if (["SUCCEEDED", "FAILED", "REJECTED", "AWAITING_AUTHORIZATION"].includes(result.status)) return result;
    const claim = copyClaim(stored.claim);
    const storedQuote = stored.quote;
    const minimum = stored.minimumSpentBefore;
    const cap = stored.aggregateCap;
    if (!storedQuote || !validAmount(storedQuote.merchantReceive, true) || !quoteIsUsable(storedQuote, claim, storedQuote.merchantReceive, 0) ||
        !validAmount(minimum) || !validAmount(cap, true) || !sameAsset(minimum, cap) || !sameAsset(storedQuote.payerDebit, cap) ||
        BigInt(minimum.value) + BigInt(storedQuote.payerDebit.value) > BigInt(cap.value)) throw new PaymentEngineError("PAYMENT_OUTCOME_UNKNOWN");
    const quote = copyQuote(storedQuote);
    const validation: SubmissionValidation = Object.freeze({
      minimumSpentBefore: Object.freeze(copyAmount(minimum)), aggregateCap: Object.freeze(copyAmount(cap)), validUntilEpochMs: quote.expiresAtEpochMs,
    });
    const reference = stored.providerAttemptRef;
    if (!identifier(reference)) return recordOutcome(claim, unknownResult(claim), this.ports);
    let observation: ProviderExecutionObservation;
    try { observation = await this.ports.provider.readPayment({ claim, quote, providerAttemptRef: reference }); } catch {
      return recordOutcome(claim, unknownResult(claim), this.ports, reference);
    }
    if (typeof observation !== "object" || observation === null || Array.isArray(observation) ||
        ("providerAttemptRef" in observation && observation.providerAttemptRef !== undefined && observation.providerAttemptRef !== reference)) {
      return recordOutcome(claim, unknownResult(claim), this.ports, reference);
    }
    return applyProviderObservation(claim, quote, validation, { ...observation, providerAttemptRef: reference }, this.ports);
  }
}
