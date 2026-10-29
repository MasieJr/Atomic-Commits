import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { isValidMoney, sameAsset, type Money } from "../domain/payment-engine/money";
import {
  evaluateOfflinePreQuotePolicy,
  evaluateOfflineSpendingPolicy,
  type OfflineDeviceEnrollment,
  type OfflinePolicyContext,
  type OfflinePreQuoteContext,
} from "../domain/payment-engine/offline-spending-policy";
import { offlineRedemptionFingerprint, verifyOfflineInstruction } from "../domain/payment-engine/offline-redemption";
import { parseSignedOfflineInstruction, type OfflineInstructionV1 } from "../domain/payment-engine/signed-offline-instruction";
import type { PaymentEvidence } from "../services/payment-proof-run";

type ClaimState = "RESERVED" | "SUBMITTING" | "CONFIRMED" | "REJECTED" | "UNKNOWN";

/** Development-only authentication; Josue's real merchant identity is separate. */
export class DevelopmentMerchantAuthenticator {
  private readonly secret = randomBytes(32);
  constructor(readonly scopeId: string, readonly walletId: string) {
    if (process.env.NODE_ENV === "production" || !scopeId || !walletId) throw new Error("Development merchant authentication is unavailable.");
  }
  credential(): Buffer { return Buffer.from(this.secret); }
  authenticate(credential: Uint8Array): boolean {
    return credential instanceof Uint8Array && credential.length === this.secret.length && timingSafeEqual(credential, this.secret);
  }
}

interface DevelopmentClaim {
  readonly paymentId: string;
  readonly nonce: string;
  readonly authorizationId: string;
  readonly maximum: Money;
  state: ClaimState;
}

/**
 * Single-process proof adapter only. It is neither durable nor safe across
 * replicas. Nonces stay consumed after rejection; uncertain submissions retain
 * their full reservation. Production requires Josue's transactional adapter.
 */
export class DevelopmentReservationStore {
  private readonly claims = new Map<string, DevelopmentClaim>();
  private readonly freshGrantClaims = new Set<string>();
  private readonly confirmed = new Map<string, bigint>();
  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("In-memory reservations are development-only.");
  }
  hasNonce(nonce: string): boolean { return this.claims.has(nonce); }
  state(nonce: string): ClaimState | undefined { return this.claims.get(nonce)?.state; }

  /** Account for other outstanding claims and locally confirmed debits. */
  withOutstanding(context: OfflinePreQuoteContext, excludeNonce?: string): OfflinePreQuoteContext {
    if (!isValidMoney(context.outstandingReservations) || !isValidMoney(context.grant.cumulativeSpent)) throw new Error("Invalid reservation context.");
    let held = BigInt(context.outstandingReservations.value);
    for (const claim of this.claims.values()) {
      if (claim.nonce !== excludeNonce && claim.authorizationId === context.grant.authorizationId &&
        ["RESERVED", "SUBMITTING", "UNKNOWN"].includes(claim.state)) {
        if (!sameAsset(claim.maximum, context.outstandingReservations)) throw new Error("Reservation asset mismatch.");
        held += BigInt(claim.maximum.value);
      }
    }
    const locallyConfirmed = this.confirmed.get(context.grant.authorizationId) ?? 0n;
    const storedSpent = BigInt(context.grant.cumulativeSpent.value);
    return {
      ...context,
      grant: { ...context.grant, cumulativeSpent: { ...context.grant.cumulativeSpent, value: (storedSpent > locallyConfirmed ? storedSpent : locallyConfirmed).toString() } },
      outstandingReservations: { ...context.outstandingReservations, value: held.toString() },
    };
  }

  /** Synchronous check-and-reserve within this one simulator process. */
  claim(instruction: OfflineInstructionV1, context: OfflinePreQuoteContext): { kind: "CLAIMED"; paymentId: string; reservedMaximum: Money } | { kind: "REJECTED"; code: string } {
    if (this.claims.has(instruction.nonce)) return { kind: "REJECTED", code: "OFFLINE_CREDENTIAL_ALREADY_CLAIMED" };
    if (context.authority.spentDebit === null && this.freshGrantClaims.has(context.grant.authorizationId)) {
      return { kind: "REJECTED", code: "GRANT_REAUTHORIZATION_REQUIRED" };
    }
    const decision = evaluateOfflinePreQuotePolicy(instruction, this.withOutstanding(context));
    if (!decision.allowed) return { kind: "REJECTED", code: decision.code };
    const paymentId = randomUUID();
    this.claims.set(instruction.nonce, {
      paymentId, nonce: instruction.nonce, authorizationId: context.grant.authorizationId,
      maximum: { ...decision.maxPotentialDebit }, state: "RESERVED",
    });
    if (decision.requiresInitialCounterReconciliation) this.freshGrantClaims.add(context.grant.authorizationId);
    return { kind: "CLAIMED", paymentId, reservedMaximum: { ...decision.maxPotentialDebit } };
  }

  markSubmitting(nonce: string): void {
    const claim = this.claims.get(nonce);
    if (!claim || claim.state !== "RESERVED") throw new Error("The reservation cannot be submitted.");
    claim.state = "SUBMITTING";
  }

  finish(nonce: string, state: "CONFIRMED" | "REJECTED" | "UNKNOWN", debit?: Money): void {
    const claim = this.claims.get(nonce);
    if (!claim || !["RESERVED", "SUBMITTING"].includes(claim.state)) throw new Error("The reservation cannot be finalized.");
    if (state !== "REJECTED" && claim.state !== "SUBMITTING") throw new Error("The reservation was not submitted.");
    if (state === "CONFIRMED") {
      if (!debit || !isValidMoney(debit) || !sameAsset(debit, claim.maximum) || BigInt(debit.value) > BigInt(claim.maximum.value)) {
        throw new Error("The confirmed debit cannot be reconciled.");
      }
      this.confirmed.set(claim.authorizationId, (this.confirmed.get(claim.authorizationId) ?? 0n) + BigInt(debit.value));
    }
    claim.state = state;
  }
}

export interface DevelopmentMerchantPorts<Prepared> {
  /** Only the actual Test Wallet adapter may label provider observations live. */
  readonly evidenceSource: "SIMULATED" | "TEST_WALLET";
  readonly merchant: DevelopmentMerchantAuthenticator;
  readonly reservations: DevelopmentReservationStore;
  nowEpochMs(): number;
  loadDeviceEnrollment(envelopeId: string, deviceId: string, keyVersion: string): Promise<OfflineDeviceEnrollment | undefined>;
  loadPreQuoteContext(envelopeId: string, merchantScopeId: string): Promise<OfflinePreQuoteContext | undefined>;
  prepareFreshQuote(instruction: OfflineInstructionV1, receive: Money, context: OfflinePreQuoteContext): Promise<{ prepared: Prepared; context: OfflinePolicyContext }>;
  revalidateGrant(prepared: Prepared, context: OfflinePolicyContext): Promise<boolean>;
  recordBeforeSubmission(prepared: Prepared, paymentId: string, fingerprint: string): Promise<void>;
  submitAndConfirm(prepared: Prepared, remainingBudget: Money, ceiling: Money): Promise<PaymentEvidence>;
  currentEvidence(prepared: Prepared): PaymentEvidence | undefined;
  reconcileCounter(evidence: PaymentEvidence): Promise<boolean>;
}

export type DevelopmentOfflineResult =
  | { status: "CONFIRMED" | "SIMULATED"; paymentId: string; debit: Money; receive: Money }
  | { status: "REJECTED"; code: string }
  | { status: "UNKNOWN"; paymentId: string }
  | { status: "INCONCLUSIVE"; paymentId: string; paymentState: "SUCCEEDED" };

function confirmedAmounts(evidence: PaymentEvidence, signed: OfflineInstructionV1, receive: Money, reservedMaximum: Money): boolean {
  if (evidence.state !== "SUCCEEDED" || !evidence.outgoingPaymentId || !evidence.incomingPaymentId || !evidence.quoteId ||
    !isValidMoney(evidence.quotedDebit) || !isValidMoney(evidence.quotedReceive) ||
    !isValidMoney(evidence.sentAmount) || !isValidMoney(evidence.receivedAmount)) return false;
  const ceiling: Money = { value: signed.maxDebitMinor, assetCode: signed.assetCode, assetScale: signed.assetScale };
  return sameAsset(evidence.quotedDebit, ceiling) && BigInt(evidence.quotedDebit.value) > 0n &&
    BigInt(evidence.quotedDebit.value) <= BigInt(ceiling.value) &&
    sameAsset(evidence.quotedDebit, reservedMaximum) && BigInt(evidence.quotedDebit.value) <= BigInt(reservedMaximum.value) &&
    sameAsset(evidence.sentAmount, evidence.quotedDebit) && evidence.sentAmount.value === evidence.quotedDebit.value &&
    sameAsset(evidence.quotedReceive, receive) && evidence.quotedReceive.value === receive.value &&
    sameAsset(evidence.receivedAmount, receive) && evidence.receivedAmount.value === receive.value;
}

function sameAmount(left: Money, right: Money): boolean {
  return isValidMoney(left) && isValidMoney(right) && sameAsset(left, right) && left.value === right.value;
}

/** Execute the separate merchant-bound exact-purchase flow. */
export async function executeDevelopmentOfflinePurchase<Prepared>(
  input: unknown,
  merchantCredential: Uint8Array,
  merchantReceive: Money,
  ports: DevelopmentMerchantPorts<Prepared>,
): Promise<DevelopmentOfflineResult> {
  return executeDevelopmentInstruction(input, merchantCredential, merchantReceive, ports, "EXACT");
}

/** Redeem a ceiling voucher without requiring the sender to choose a merchant. */
export async function executeDevelopmentOfflineVoucher<Prepared>(
  input: unknown,
  merchantCredential: Uint8Array,
  merchantReceive: Money,
  ports: DevelopmentMerchantPorts<Prepared>,
): Promise<DevelopmentOfflineResult> {
  return executeDevelopmentInstruction(input, merchantCredential, merchantReceive, ports, "VOUCHER");
}

async function executeDevelopmentInstruction<Prepared>(
  input: unknown,
  merchantCredential: Uint8Array,
  merchantReceive: Money,
  ports: DevelopmentMerchantPorts<Prepared>,
  mode: "EXACT" | "VOUCHER",
): Promise<DevelopmentOfflineResult> {
  if (process.env.NODE_ENV === "production" || !ports.merchant.authenticate(merchantCredential)) {
    return { status: "REJECTED", code: "MERCHANT_NOT_VERIFIED" };
  }
  const parsed = parseSignedOfflineInstruction(input);
  if (!parsed || (mode === "EXACT" && !parsed.payload.exactPurchase) ||
    (mode === "VOUCHER" && (parsed.payload.exactPurchase !== undefined || parsed.payload.merchantScopeId !== undefined))) {
    return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" };
  }
  const verified = await verifyOfflineInstruction(input, ports.merchant.scopeId, merchantReceive, ports.loadDeviceEnrollment.bind(ports));
  if (verified.status !== "VERIFIED") return verified;
  const instruction = verified.instruction.payload;
  if (ports.reservations.hasNonce(instruction.nonce)) return { status: "REJECTED", code: "OFFLINE_CREDENTIAL_ALREADY_CLAIMED" };

  let preContext: OfflinePreQuoteContext | undefined;
  try { preContext = await ports.loadPreQuoteContext(instruction.envelopeId, ports.merchant.scopeId); } catch { /* fail closed */ }
  if (!preContext) return { status: "REJECTED", code: "GRANT_REAUTHORIZATION_REQUIRED" };
  if (!preContext.merchant || !preContext.device || preContext.merchant.scopeId !== ports.merchant.scopeId || preContext.merchant.walletId !== ports.merchant.walletId ||
    preContext.device.publicKey !== verified.enrollment.publicKey || preContext.device.ownerUserId !== verified.enrollment.ownerUserId ||
    preContext.device.revocationVersion !== verified.enrollment.revocationVersion) return { status: "REJECTED", code: "DEVICE_NOT_VERIFIED" };
  try { preContext = { ...preContext, nowEpochMs: ports.nowEpochMs() }; } catch { return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" }; }
  let claim: ReturnType<DevelopmentReservationStore["claim"]>;
  try { claim = ports.reservations.claim(instruction, preContext); } catch { return { status: "REJECTED", code: "INVALID_PAYMENT_REQUEST" }; }
  if (claim.kind !== "CLAIMED") return { status: "REJECTED", code: claim.code };

  const fingerprint = offlineRedemptionFingerprint(instruction, ports.merchant.scopeId, verified.requestedReceive);
  let prepared: Prepared;
  let quoteContext: OfflinePolicyContext;
  try {
    const fresh = await ports.prepareFreshQuote(instruction, verified.requestedReceive, preContext);
    prepared = fresh.prepared;
    const withOthers = ports.reservations.withOutstanding(fresh.context, instruction.nonce);
    quoteContext = { ...fresh.context, ...withOthers, nowEpochMs: ports.nowEpochMs(), expectedMerchantReceive: verified.requestedReceive };
    if (quoteContext.device.publicKey !== verified.enrollment.publicKey || quoteContext.device.ownerUserId !== verified.enrollment.ownerUserId ||
      quoteContext.device.revocationVersion !== verified.enrollment.revocationVersion ||
      quoteContext.envelope.ownerUserId !== preContext.envelope.ownerUserId || quoteContext.envelope.authorizationId !== preContext.envelope.authorizationId ||
      quoteContext.envelope.grantRevocationVersion !== preContext.envelope.grantRevocationVersion ||
      quoteContext.envelope.deviceRevocationVersion !== preContext.envelope.deviceRevocationVersion ||
      quoteContext.authority.snapshotId !== preContext.authority.snapshotId ||
      !sameAmount(quoteContext.envelope.perPaymentMaxDebit, preContext.envelope.perPaymentMaxDebit) ||
      !sameAmount(quoteContext.envelope.cumulativeCap, preContext.envelope.cumulativeCap) ||
      !sameAmount(quoteContext.grant.cumulativeCap, preContext.grant.cumulativeCap) ||
      !sameAmount(quoteContext.authority.cumulativeCap, preContext.authority.cumulativeCap) ||
      quoteContext.merchant.scopeId !== ports.merchant.scopeId || quoteContext.merchant.walletId !== ports.merchant.walletId) throw new Error("Enrollment or authority changed.");
    const decision = evaluateOfflineSpendingPolicy(instruction, quoteContext);
    if (!decision.allowed || !sameAsset(quoteContext.quote.payerDebit, claim.reservedMaximum) ||
      BigInt(quoteContext.quote.payerDebit.value) > BigInt(claim.reservedMaximum.value) ||
      !await ports.revalidateGrant(prepared, quoteContext)) throw new Error("Quote or grant refused.");
  } catch {
    ports.reservations.finish(instruction.nonce, "REJECTED");
    return { status: "REJECTED", code: "QUOTE_OR_GRANT_UNVERIFIABLE" };
  }

  const spent = quoteContext.authority.spentDebit === null ? 0n : BigInt(quoteContext.authority.spentDebit.value);
  const localSpent = BigInt(quoteContext.grant.cumulativeSpent.value);
  const remaining = BigInt(quoteContext.authority.cumulativeCap.value) - (spent > localSpent ? spent : localSpent) - BigInt(quoteContext.outstandingReservations.value);
  const remainingBudget: Money = { ...quoteContext.authority.cumulativeCap, value: remaining.toString() };
  const ceiling: Money = { ...claim.reservedMaximum };
  try {
    ports.reservations.markSubmitting(instruction.nonce);
    await ports.recordBeforeSubmission(prepared, claim.paymentId, fingerprint);
  } catch {
    ports.reservations.finish(instruction.nonce, "REJECTED");
    return { status: "REJECTED", code: "SUBMISSION_NOT_STARTED" };
  }

  let evidence: PaymentEvidence;
  try {
    evidence = await ports.submitAndConfirm(prepared, remainingBudget, ceiling);
  } catch {
    let current: PaymentEvidence | undefined;
    try { current = ports.currentEvidence(prepared); } catch { /* preserve uncertainty */ }
    // Only a pre-submit refusal, a definitive no-ID rejection, or a provider-
    // confirmed failure with an explicit zero sent amount may release budget.
    const failedWithoutDebit = current?.state === "FAILED" && (
      !current.outgoingPaymentId ||
      (isValidMoney(current.sentAmount) && sameAsset(current.sentAmount, ceiling) && current.sentAmount.value === "0")
    );
    if (current?.state === "PREPARED" || failedWithoutDebit) {
      ports.reservations.finish(instruction.nonce, "REJECTED");
      return { status: "REJECTED", code: "PAYMENT_NOT_SUBMITTED" };
    }
    ports.reservations.finish(instruction.nonce, "UNKNOWN");
    return { status: "UNKNOWN", paymentId: claim.paymentId };
  }
  if (!confirmedAmounts(evidence, instruction, verified.requestedReceive, claim.reservedMaximum)) {
    ports.reservations.finish(instruction.nonce, "UNKNOWN");
    return { status: "UNKNOWN", paymentId: claim.paymentId };
  }
  let counterConfirmed = false;
  try { counterConfirmed = await ports.reconcileCounter(evidence); } catch { /* retain the reservation */ }
  if (!counterConfirmed) {
    ports.reservations.finish(instruction.nonce, "UNKNOWN");
    return { status: "INCONCLUSIVE", paymentId: claim.paymentId, paymentState: "SUCCEEDED" };
  }
  ports.reservations.finish(instruction.nonce, "CONFIRMED", evidence.quotedDebit);
  return { status: ports.evidenceSource === "TEST_WALLET" ? "CONFIRMED" : "SIMULATED", paymentId: claim.paymentId, debit: { ...evidence.sentAmount! }, receive: { ...evidence.receivedAmount! } };
}
