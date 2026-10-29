import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { OpenPaymentsClientError } from "@interledger/open-payments";

import { evaluateOfflineSpendingPolicy, type OfflinePolicyContext, type OfflinePreQuoteContext } from "../domain/payment-engine/offline-spending-policy";
import type { Money } from "../domain/payment-engine/money";
import type { OfflineInstructionV1 } from "../domain/payment-engine/signed-offline-instruction";
import { validateReturnedOutgoingGrant } from "../services/outgoing-grant-validation";
import type { FreshGrantCounterObservation, OutgoingGrantLifecycle } from "../services/grant-lifecycle";
import type { ApprovedSpending, PaymentProofs, PreparedPayment } from "../services/payment-proof";
import { minorValue, ProofStepError, sameAsset } from "../services/payment-proof-run";
import { sanitizedProviderCode } from "../services/payment-proof-c";
import {
  DevelopmentMerchantAuthenticator,
  DevelopmentReservationStore,
  type DevelopmentMerchantPorts,
} from "./offline-merchant-simulator";

/** Side-effect-free composition; network calls occur only when its methods are invoked. */
export function createOfflineTestWalletPorts(options: {
  proofs: PaymentProofs;
  spending: ApprovedSpending;
  lifecycle: OutgoingGrantLifecycle;
  initialCounter: FreshGrantCounterObservation;
  preContext: OfflinePreQuoteContext;
  merchant: DevelopmentMerchantAuthenticator;
  reservations: DevelopmentReservationStore;
  mode?: "EXACT" | "VOUCHER" | "TRIP";
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): DevelopmentMerchantPorts<PreparedPayment> {
  const { proofs, spending, lifecycle, initialCounter, preContext, merchant, reservations } = options;
  const label = options.mode === "TRIP" ? "offline-trip" : options.mode === "VOUCHER" ? "offline-voucher" : "offline-exact";
  const reportKey = options.mode === "TRIP" ? "offlineTrip" : options.mode === "VOUCHER" ? "offlineVoucher" : "offlineExact";
  const clock = options.clock ?? (() => Date.now());
  const sleep = options.sleep ?? (async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: proofs.run.controller.signal }); });
  const counterAuthority = {
    accessToken: spending.grant.access_token.value,
    budget: spending.budget,
    resourceServerUrl: proofs.sender.resourceServer,
  };
  // This proof runs payments sequentially under one grant. Only a validated
  // provider reading after a confirmed payment advances the local snapshot.
  let currentSpent: Money | null = preContext.authority.spentDebit && { ...preContext.authority.spentDebit };
  let confirmedSpent = currentSpent === null ? 0n : minorValue(currentSpent.value);
  let snapshotId = preContext.authority.snapshotId;
  let observedAt = preContext.authority.observedAtEpochMs;
  let paymentSequence = 0;
  const policies = new WeakMap<PreparedPayment, { instruction: OfflineInstructionV1; receive: Money; context: OfflinePreQuoteContext }>();
  const recordPreparationFailure = async (error: unknown): Promise<void> => {
    const step = error instanceof ProofStepError ? error.step : "";
    const original = error instanceof ProofStepError ? error.original : error;
    const stage = step === "request recipient incoming-payment grant" ? "INCOMING_GRANT" :
      step === "request payer quote grant" ? "QUOTE_GRANT" :
      step.endsWith(": revalidate provider counter") ? "COUNTER_READ" :
      step.includes(": create fresh incoming payment") ? "INCOMING_PAYMENT" :
      step.includes(": create fresh quote") ? "QUOTE" : "PREPARATION";
    const provider = original instanceof OpenPaymentsClientError ? original : undefined;
    const status = provider?.status;
    const code = sanitizedProviderCode(provider?.code);
    const previous = proofs.run.report.results[reportKey] as Record<string, unknown> | undefined;
    proofs.run.report.results[reportKey] = { ...previous, lastPreparationFailure: {
      stage,
      classification: provider ? "PROVIDER_ERROR" : "UNEXPECTED_ERROR",
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}),
      ...(code === undefined ? {} : { providerCode: code }),
    } };
    try { await proofs.run.save(); } catch { /* retain the original failure */ }
  };
  const quoteContextFor = (prepared: Readonly<PreparedPayment>, receive: Money, context: OfflinePreQuoteContext): OfflinePolicyContext => {
    if (prepared.incoming.walletAddress !== proofs.receiver.id || prepared.quote.walletAddress !== proofs.sender.id ||
      prepared.quote.receiver !== prepared.incoming.id) throw new Error("The fresh provider quote does not match the intended wallets.");
    return {
      ...context,
      nowEpochMs: clock(),
      quote: {
        quoteId: prepared.quote.id,
        merchantScopeId: merchant.scopeId,
        payerWalletId: proofs.sender.id,
        receiverWalletId: proofs.receiver.id,
        payerDebit: prepared.quote.debitAmount,
        merchantReceive: prepared.quote.receiveAmount,
        expiresAtEpochMs: Date.parse(prepared.quote.expiresAt ?? ""),
      },
      expectedMerchantReceive: receive,
    };
  };
  return {
    evidenceSource: "TEST_WALLET",
    merchant,
    reservations,
    nowEpochMs: clock,
    loadDeviceEnrollment: async (envelopeId, deviceId, keyVersion) =>
      envelopeId === preContext.envelope.envelopeId && deviceId === preContext.device.deviceId && keyVersion === preContext.device.keyVersion
        ? { ...preContext.device } : undefined,
    loadPreQuoteContext: async (envelopeId, merchantScopeId) =>
      envelopeId === preContext.envelope.envelopeId && merchantScopeId === preContext.merchant.scopeId
        ? { ...preContext, nowEpochMs: clock(),
          grant: { ...preContext.grant, cumulativeSpent: { ...preContext.grant.cumulativeSpent, value: confirmedSpent.toString() } },
          authority: { ...preContext.authority, snapshotId, observedAtEpochMs: observedAt,
            spentDebit: currentSpent && { ...currentSpent }, freshGrantEmpty: currentSpent === null },
        } : undefined,
    prepareFreshQuote: async (instruction, receive, context) => {
      try {
        await proofs.ensureResourceGrants();
        const prepared = await proofs.prepare(options.mode === "TRIP" ? `${label}-${++paymentSequence}` : label);
        policies.set(prepared, { instruction, receive: { ...receive }, context });
        return { prepared, context: quoteContextFor(prepared, receive, context) };
      } catch (error) {
        await recordPreparationFailure(error);
        throw error;
      }
    },
    revalidateGrant: async (_prepared, context) => {
      try {
        lifecycle.requireSpendable();
        if (context.authority.snapshotId !== snapshotId) return false;
        if (typeof spending.expiresAt !== "number" || spending.expiresAt <= clock() + 5000) return false;
        const verified = validateReturnedOutgoingGrant(spending.grant, { payerId: proofs.sender.id, requestedDebit: spending.budget });
        if (!sameAsset(verified.budget, spending.budget) || minorValue(verified.budget.value) !== minorValue(spending.budget.value)) return false;
        // Before the first debit, a fresh grant may still return the explicit null/null pair.
        // Re-read it rather than substituting a numeric zero; all other missing states fail.
        const amounts = await proofs.run.step(`${label}: revalidate provider counter`, () => proofs.client.outgoingPayment.getGrantSpentAmounts({
          url: proofs.sender.resourceServer,
          accessToken: spending.grant.access_token.value,
        }));
        if (typeof amounts !== "object" || amounts === null || !Object.hasOwn(amounts, "spentDebitAmount") || !Object.hasOwn(amounts, "spentReceiveAmount")) return false;
        if (amounts.spentDebitAmount === null && amounts.spentReceiveAmount === null) {
          return currentSpent === null && confirmedSpent === 0n && initialCounter.kind === "EMPTY";
        }
        const debit = amounts.spentDebitAmount;
        if (!debit || !sameAsset(debit, spending.budget) || minorValue(debit.value) !== confirmedSpent) return false;
        if (amounts.spentReceiveAmount) minorValue(amounts.spentReceiveAmount.value);
        return true;
      } catch (error) {
        await recordPreparationFailure(error);
        throw error;
      }
    },
    recordBeforeSubmission: async (_prepared, paymentId, fingerprint) => {
      const previous = proofs.run.report.results[reportKey] as Record<string, unknown> | undefined;
      proofs.run.report.results[reportKey] = { ...previous, status: "SUBMITTING", paymentId, requestFingerprint: fingerprint };
      await proofs.run.save();
    },
    submitAndConfirm: (prepared, remaining, ceiling) => {
      const binding = policies.get(prepared);
      if (!binding) throw new Error("The prepared payment has no verified instruction binding.");
      return proofs.pay(prepared, spending, remaining, ceiling, (current) => {
        // PaymentProofs may refresh a stale quote internally. Revalidate the
        // actual quote after that refresh, before any outgoing POST.
        const fresh = quoteContextFor(current, binding.receive, binding.context);
        const withOthers = reservations.withOutstanding(fresh, binding.instruction.nonce);
        const finalContext = { ...fresh, ...withOthers, nowEpochMs: clock(), expectedMerchantReceive: binding.receive };
        if (!evaluateOfflineSpendingPolicy(binding.instruction, finalContext).allowed) {
          throw new Error("The final provider quote does not satisfy the signed instruction.");
        }
      });
    },
    currentEvidence: (prepared) => prepared.evidence,
    reconcileCounter: async (evidence) => {
      const expected = confirmedSpent + minorValue(evidence.quotedDebit.value);
      const deadline = clock() + proofs.config.settlementTimeoutMs;
      for (;;) {
        proofs.run.controller.signal.throwIfAborted();
        const reading = await lifecycle.verifySpentCounter(counterAuthority);
        const previous = proofs.run.report.results[reportKey] as { counterReadings?: unknown[] } | undefined;
        proofs.run.report.results[reportKey] = { ...previous,
          counterReadings: [...(Array.isArray(previous?.counterReadings) ? previous.counterReadings : []),
            { readAt: reading.readAt, spentDebit: { ...reading.spentDebit } }],
        };
        await proofs.run.save();
        const value = minorValue(reading.spentDebit.value);
        if (value === expected) {
          confirmedSpent = value;
          currentSpent = { ...reading.spentDebit };
          observedAt = reading.readAt;
          snapshotId = randomUUID();
          return true;
        }
        if (value > expected || clock() >= deadline) return false;
        await sleep(Math.min(1000, Math.max(1, deadline - clock())));
      }
    },
  };
}
