import { generateKeyPairSync, randomUUID } from "node:crypto";
import { config as loadDotenv } from "dotenv";

import type { GrantAuthorization } from "../domain/payment-engine/grants";
import type { OfflinePreQuoteContext } from "../domain/payment-engine/offline-spending-policy";
import { createOfflineTestWalletPorts } from "../dev/offline-test-wallet";
import { DevelopmentMerchantAuthenticator, DevelopmentReservationStore, executeDevelopmentOfflinePurchase, executeDevelopmentOfflineVoucher } from "../dev/offline-merchant-simulator";
import { runOfflineSender, runOfflineVoucherSender } from "../dev/offline-sender-process";
import { OutgoingGrantLifecycle } from "../services/grant-lifecycle";
import { PaymentProofs } from "../services/payment-proof";
import { finalizeProofCRun } from "../services/payment-proof-c-finalization";
import { readProofCConfig } from "../services/payment-proof-c";
import { minorValue, ProofRun, readProofConfig, sameAsset } from "../services/payment-proof-run";

export type OfflineProofMode = "EXACT" | "VOUCHER" | "TRIP";

/** Voucher mode derives its transaction ceiling from the single trip budget. */
export function readOfflineProofMoney(env: Record<string, string | undefined>, mode: OfflineProofMode) {
  return readProofCConfig(mode === "VOUCHER"
    ? { ...env, PAYMENT_PROOF_C_MAX_DEBIT_MINOR: env.PAYMENT_PROOF_BUDGET_MINOR }
    : env);
}

function instructionTtlMs(mode: OfflineProofMode): number {
  const name = mode === "TRIP" ? "PAYMENT_OFFLINE_TRIP_TTL_SECONDS" : mode === "VOUCHER" ? "PAYMENT_OFFLINE_VOUCHER_TTL_SECONDS" : "PAYMENT_OFFLINE_EXACT_TTL_SECONDS";
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 10 || value > 300) {
    throw new Error(`Set ${name} to an integer between 10 and 300.`);
  }
  return value * 1000;
}

async function live(mode: OfflineProofMode): Promise<void> {
  loadDotenv();
  const money = readOfflineProofMoney(process.env, mode);
  const runtime = readProofConfig();
  const ttlMs = instructionTtlMs(mode);
  const label = mode === "TRIP" ? "offline-trip" : mode === "VOUCHER" ? "offline-voucher" : "offline-exact";
  const reportKey = mode === "TRIP" ? "offlineTrip" : mode === "VOUCHER" ? "offlineVoucher" : "offlineExact";
  const expectedPayments = mode === "TRIP" ? 4 : 1;
  const run = new ProofRun(label);
  await run.start();
  const interrupt = () => run.controller.abort(new Error("Offline payment proof interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let proofs: PaymentProofs | undefined;
  let failure: unknown;
  try {
    proofs = await PaymentProofs.create(run, runtime);
    if (proofs.sender.assetCode !== money.aggregateBudget.assetCode || proofs.sender.assetScale !== money.aggregateBudget.assetScale ||
      proofs.receiver.assetCode !== money.receiveAmount.assetCode || proofs.receiver.assetScale !== money.receiveAmount.assetScale) {
      throw new Error("Configured assets do not match the Test Wallet metadata.");
    }

    // Online enrollment/consent precedes the separate offline sender process.
    const authorizationStartedAt = Date.now();
    const issued = await proofs.authorize(label, money.aggregateBudget);
    const advertisedLifetime = issued.grant.access_token.expires_in;
    if (typeof advertisedLifetime !== "number" || !Number.isSafeInteger(advertisedLifetime * 1000) ||
      !Number.isSafeInteger(authorizationStartedAt + advertisedLifetime * 1000) || typeof issued.expiresAt !== "number") {
      throw new Error("The access-token deadline cannot be verified.");
    }
    // Anchor conservatively before consent rather than extending the token's
    // usable window by network or approval latency.
    const spending = { ...issued, expiresAt: Math.min(issued.expiresAt, authorizationStartedAt + advertisedLifetime * 1000) };
    // A voucher carries the accepted trip cap; the backend automatically
    // narrows the reservation to the remaining allowance at redemption.
    const transactionCeiling = mode === "VOUCHER" ? spending.budget : money.perPaymentMaxDebit;
    if (!sameAsset(spending.budget, transactionCeiling) || minorValue(transactionCeiling.value) > minorValue(spending.budget.value) ||
      spending.expiresAt <= Date.now() + 5000) throw new Error("The accepted grant cannot support the configured ceiling or timing.");
    if (mode === "TRIP" && minorValue(spending.budget.value) !== minorValue(money.aggregateBudget.value)) {
      throw new Error("The provider did not accept the requested trip cap exactly.");
    }
    const lifecycle = new OutgoingGrantLifecycle({
      rotateToken: (args) => proofs!.client.token.rotate(args),
      readSpentAmounts: (args) => proofs!.client.outgoingPayment.getGrantSpentAmounts(args),
      clock: () => Date.now(),
      rememberSecret: (value) => run.rememberSecret(value),
    });
    const initialCounter = await lifecycle.readFreshGrantCounter({
      accessToken: spending.grant.access_token.value, budget: spending.budget, resourceServerUrl: proofs.sender.resourceServer,
    });
    if (initialCounter.kind === "COUNTER" && minorValue(initialCounter.reading.spentDebit.value) !== 0n) {
      throw new Error("The newly approved grant already reports spending.");
    }

    const now = Date.now();
    const expiry = now + ttlMs;
    const permissionDeadline = spending.expiresAt - 5000;
    if (!Number.isSafeInteger(expiry) || expiry >= permissionDeadline) throw new Error("The instruction lifetime exceeds the current permission window.");
    const authorizationId = randomUUID();
    const envelopeId = randomUUID();
    const deviceId = randomUUID();
    const keyVersion = "dev-1";
    const ownerUserId = 1; // isolated simulator identity, not an app-user ownership assertion
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x;
    if (typeof publicKey !== "string") throw new Error("Could not establish the simulator device key.");
    const zero = { ...spending.budget, value: "0" };
    const grant: GrantAuthorization = {
      authorizationId, userId: ownerUserId, status: "ACTIVE", authorityRef: "development-only", kind: "OUTGOING_PAYMENT",
      perPaymentMaxDebit: transactionCeiling, cumulativeCap: spending.budget, cumulativeSpent: zero,
      validFromEpochMs: now - 1000, validUntilEpochMs: permissionDeadline,
      payerAssetCode: spending.budget.assetCode, payerAssetScale: spending.budget.assetScale, revocationVersion: 1,
    };
    // Voucher signing receives only the previously enrolled envelope and the
    // payer's ceiling: neither the merchant nor purchase price is sent to it.
    const senderInput = { envelopeId, authorizationId, deviceId, keyVersion,
      maxPayerDebit: transactionCeiling, issuedAtEpochMs: now, expiresAtEpochMs: expiry };
    const instructions = mode === "EXACT"
      ? [runOfflineSender({ ...senderInput, merchantScopeId: proofs.receiver.id, merchantReceive: money.receiveAmount }, keys.privateKey)]
      : Array.from({ length: expectedPayments }, () => runOfflineVoucherSender(senderInput, keys.privateKey));

    // The online merchant is selected only after the voucher has been created.
    const merchant = new DevelopmentMerchantAuthenticator(proofs.receiver.id, proofs.receiver.id);
    const reservations = new DevelopmentReservationStore();
    const preContext: OfflinePreQuoteContext = {
      nowEpochMs: now,
      envelope: {
        version: "1", envelopeId, authorizationId, ownerUserId, payerWalletId: proofs.sender.id,
        deviceId, deviceKeyVersion: keyVersion, deviceRevocationVersion: 1, grantRevocationVersion: 1,
        perPaymentMaxDebit: transactionCeiling, cumulativeCap: spending.budget,
        validFromEpochMs: now - 1000, validUntilEpochMs: expiry, revoked: false,
        ...(mode === "EXACT" ? { merchantScopeId: proofs.receiver.id } : {}),
      },
      grant,
      authority: {
        ownerUserId, authorizationId, payerWalletId: proofs.sender.id, usable: true, restrictionsVerified: true,
        snapshotId: randomUUID(), observedAtEpochMs: initialCounter.kind === "EMPTY" ? initialCounter.readAt : initialCounter.reading.readAt,
        validUntilEpochMs: permissionDeadline, cumulativeCap: spending.budget,
        spentDebit: initialCounter.kind === "EMPTY" ? null : initialCounter.reading.spentDebit,
        ...(initialCounter.kind === "EMPTY" ? { freshGrantEmpty: true } : {}),
      },
      device: { ownerUserId, deviceId, keyVersion, revocationVersion: 1, active: true, publicKey },
      wallet: { ownerUserId, walletId: proofs.sender.id, verified: true },
      merchant: { scopeId: proofs.receiver.id, walletId: proofs.receiver.id, verified: true },
      outstandingReservations: zero,
    };

    const ports = createOfflineTestWalletPorts({ proofs, spending, lifecycle, initialCounter, preContext, merchant, reservations, mode });
    const execute = mode === "EXACT" ? executeDevelopmentOfflinePurchase : executeDevelopmentOfflineVoucher;
    let perPaymentLimitRejected = false;
    if (mode === "TRIP") {
      // Exercise the R50-style per-payment policy locally with a signed value
      // one minor unit above the cap. It must stop before any provider quote.
      const above = { ...transactionCeiling, value: (minorValue(transactionCeiling.value) + 1n).toString() };
      const rejectedVoucher = runOfflineVoucherSender({ ...senderInput, maxPayerDebit: above }, keys.privateKey);
      const rejection = await executeDevelopmentOfflineVoucher(rejectedVoucher, merchant.credential(), money.receiveAmount, ports);
      if (rejection.status !== "REJECTED" || rejection.code !== "OVER_TRANSACTION_CEILING") {
        throw new Error("The per-payment ceiling did not reject an over-limit voucher.");
      }
      perPaymentLimitRejected = true;
    }
    // Persist pre-debit observations so even a partial run records the one
    // approval, offline voucher generation and the local over-limit rejection.
    const ready = run.report.results[reportKey] as Record<string, unknown> | undefined;
    run.report.results[reportKey] = {
      ...ready, status: "READY", payerInteractions: 1, expectedPayments,
      generatedInstructions: instructions.length, senderNetworkGuard: "NODE_APIS_DISABLED",
      senderBoundMerchant: mode === "EXACT", initialCounterObservation: initialCounter.kind,
      ...(mode === "TRIP" ? { perPaymentLimitRejected } : {}),
    };
    await run.save();
    const confirmed: { debit: typeof money.aggregateBudget; receive: typeof money.receiveAmount }[] = [];
    for (const signed of instructions) {
      run.controller.signal.throwIfAborted();
      const result = await execute(signed, merchant.credential(), money.receiveAmount, ports);
      if (result.status !== "CONFIRMED") throw new Error(`Offline payment proof did not confirm a payment (${result.status}).`);
      confirmed.push({ debit: result.debit, receive: result.receive });
      const partial = run.report.results[reportKey] as Record<string, unknown> | undefined;
      run.report.results[reportKey] = { ...partial, status: "IN_PROGRESS", completedPayments: confirmed.length, expectedPayments };
      await run.save();
    }
    // The same signed instruction must be rejected before any second quote/debit.
    const replay = await execute(instructions[0], merchant.credential(), money.receiveAmount, ports);
    if (replay.status !== "REJECTED" || replay.code !== "OFFLINE_CREDENTIAL_ALREADY_CLAIMED") {
      throw new Error("The completed instruction was not rejected on replay.");
    }
    const previous = run.report.results[reportKey] as Record<string, unknown> | undefined;
    run.report.results[reportKey] = {
      ...previous, status: "PASSED", senderNetworkGuard: "NODE_APIS_DISABLED", payerInteractions: 1,
      initialCounterObservation: initialCounter.kind, replayRejected: true,
      senderBoundMerchant: mode === "EXACT",
      ...(mode === "TRIP" ? { perPaymentLimitRejected } : {}),
      completedPayments: confirmed.length, expectedPayments, approvedBudget: spending.budget, perPaymentCeiling: transactionCeiling,
      confirmedDebits: confirmed.map((entry) => entry.debit), confirmedReceives: confirmed.map((entry) => entry.receive),
      confirmedDebitTotal: { ...spending.budget, value: confirmed.reduce((sum, entry) => sum + minorValue(entry.debit.value), 0n).toString() },
      ...(confirmed.length === 1 ? { confirmedDebit: confirmed[0].debit, confirmedReceive: confirmed[0].receive } : {}),
      reservationStorage: "DEVELOPMENT_IN_MEMORY_ONLY",
    };
    await run.save();
  } catch {
    failure = new Error("Offline payment proof did not complete; inspect the redacted run record.");
    process.exitCode = 1;
  } finally {
    try {
      await proofs?.cleanup();
      const cleanup = run.report.results.grantCleanup as { warnings?: unknown[]; authoritiesRetainedForUnresolvedPayments?: unknown[] } | undefined;
      if (cleanup?.warnings?.length || cleanup?.authoritiesRetainedForUnresolvedPayments?.length) {
        failure ??= new Error("Offline payment proof cleanup was incomplete.");
        process.exitCode = 1;
      }
    } catch {
      failure ??= new Error("Offline payment proof cleanup failed.");
      process.exitCode = 1;
    }
    if (failure) {
      const previous = run.report.results[reportKey] as Record<string, unknown> | undefined;
      run.report.results[reportKey] = { ...previous, status: "INCONCLUSIVE" };
    }
    const finalization = await finalizeProofCRun(run, failure, () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    });
    if (finalization.finishFailed || finalization.signalCleanupFailed || finalization.closeFailed) {
      console.error(JSON.stringify({ event: `${label}-finalization-error`, message: "The run report or lock could not be finalized." }));
      process.exitCode = 1;
    } else if (!failure) {
      const result = run.report.results[reportKey] as { status?: string; confirmedDebit?: unknown; confirmedReceive?: unknown; confirmedDebitTotal?: unknown; completedPayments?: number; replayRejected?: boolean } | undefined;
      if (result?.status === "PASSED") {
        console.log(JSON.stringify({ event: `${label}-result`, status: "PASSED", confirmedDebit: result.confirmedDebit,
          confirmedReceive: result.confirmedReceive, confirmedDebitTotal: result.confirmedDebitTotal,
          completedPayments: result.completedPayments, replayRejected: result.replayRejected }));
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Offline exact proof is development-only.");
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--voucher", "--trip", "--live", "dry"].includes(arg)) || new Set(args).size !== args.length ||
    (args.includes("dry") && args.includes("--live")) || (args.includes("--voucher") && args.includes("--trip"))) throw new Error("Use dry or --live, optionally with --voucher or --trip.");
  const mode: OfflineProofMode = args.includes("--trip") ? "TRIP" : args.includes("--voucher") ? "VOUCHER" : "EXACT";
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ event: mode === "TRIP" ? "offline-trip-proof" : mode === "VOUCHER" ? "offline-voucher-proof" : "offline-exact-proof", status: "NOT_RUN", live: false, expectedTransfers: mode === "TRIP" ? 4 : 1,
      note: "A separate sender process signs with its Node network APIs disabled; --live requires explicit approval and Test Wallet consent." }));
    return;
  }
  await live(mode);
}

if (require.main === module) {
  void main().catch(() => {
    console.error(JSON.stringify({ event: "offline-payment-error", message: "Offline payment proof could not start." }));
    process.exitCode = 1;
  });
}
