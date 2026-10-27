import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";

import { OutgoingGrantLifecycle } from "../services/grant-lifecycle";
import {
  applyCleanupOutcome,
  cleanupFailedEvidence,
  createProofCPorts,
  PROOF_C_OBSERVATION_MS,
  ProofCConfigError,
  readProofCConfig,
  runProofC,
  type ProofCCleanupOutcome,
  type ProofCConfig,
  type ProofCEvidence,
} from "../services/payment-proof-c";
import { PaymentProofs } from "../services/payment-proof";
import { ProofRun, readProofConfig, type ProofMode } from "../services/payment-proof-run";

// locally-created, constant-text usage/config errors are the ONLY messages allowed
// through the CLI's outermost error sink; SDK/free-form provider errors never reach it
class ProofCCliUsageError extends Error {}

// dry is the default and performs zero provider/credential/consent/payment/rotation
// activity: it only reads local settings and prints the redacted NOT_RUN status.
function dryStatus(configError?: string): void {
  let money: Record<string, unknown> | null = null;
  try {
    const config = readProofCConfig(process.env);
    money = {
      aggregateBudget: config.aggregateBudget,
      perPaymentMaxDebit: config.perPaymentMaxDebit,
      receiveAmount: config.receiveAmount,
    };
  } catch (error) {
    configError ??= error instanceof ProofCConfigError ? error.message : "Configuration could not be read.";
  }
  console.log(JSON.stringify({
    event: "payment-proof-c",
    status: "NOT_RUN",
    mode: "dry",
    intendedTransfers: 3,
    requiredConfirmedRotations: "at least 2, proactively before each advertised token deadline",
    observationMs: PROOF_C_OBSERVATION_MS,
    money,
    ...(configError ? { configError } : {}),
    live: false,
    note: "Dry status only: local settings are read (dotenv loads backend/.env), but no credential is used and no provider, consent, payment or rotation call is made. With explicit owner approval, an approved operator must run 'npm run payment:proof-c -- --live' for the real experiment; consent decisions remain the owner's.",
  }));
}

async function liveProofC(): Promise<void> {
  const run = new ProofRun("c" as ProofMode);
  await run.start();
  const interrupt = () => run.controller.abort(new Error("Payment proof C interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let proofs: PaymentProofs | undefined;
  let evidence: ProofCEvidence | undefined;
  let failure: unknown;
  try {
    const moneyConfig = readProofCConfig(process.env);
    const runtimeConfig = readProofConfig();
    const config: ProofCConfig = moneyConfig;
    proofs = await PaymentProofs.create(run, runtimeConfig);
    // compare wallet metadata against the explicit expectations BEFORE any consent
    if (
      proofs.sender.assetCode !== moneyConfig.aggregateBudget.assetCode || proofs.sender.assetScale !== moneyConfig.aggregateBudget.assetScale ||
      proofs.receiver.assetCode !== moneyConfig.receiveAmount.assetCode || proofs.receiver.assetScale !== moneyConfig.receiveAmount.assetScale
    ) {
      throw new Error("The configured asset codes/scales do not match the wallet metadata; fix the settings before requesting consent.");
    }

    // L2 lifecycle core owns rotation: remember-before-validate, conservative expiry, poisoning
    const lifecycle = new OutgoingGrantLifecycle({
      rotateToken: (args) => proofs!.client.token.rotate(args),
      readSpentAmounts: (args) => proofs!.client.outgoingPayment.getGrantSpentAmounts(args),
      clock: () => Date.now(),
      rememberSecret: (value) => run.rememberSecret(value),
    });
    // production port composition (holder swap on rotation, authority construction) is
    // the exported side-effect-free factory, so tests exercise the exact wiring
    const ports = createProofCPorts(
      () => Date.now(),
      async (ms) => {
        await delay(ms, undefined, { signal: run.controller.signal });
      },
      proofs,
      lifecycle,
    );

    evidence = await runProofC(config, ports);
    // a non-PASSED experiment must produce a nonzero exit and a non-passed run; the
    // run.finish() UNKNOWN precedence (an unresolved debit) is kept intact below
    if (evidence.status !== "PASSED") {
      failure = new Error(`payment proof C ended with status ${evidence.status}: ${evidence.reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Payment proof C failed unexpectedly.");
    process.exitCode = 1;
  } finally {
    let cleanupFailed = false;
    try {
      // existing ProofRun/PaymentProofs cleanup: retains outgoing+incoming read authority
      // when a payment is unknown, cancels resolved grants, records any failures
      await proofs?.cleanup();
      const stored = run.report.results.grantCleanup as { authoritiesRetainedForUnresolvedPayments?: string[]; warnings?: unknown[] } | undefined;
      if (evidence) {
        const outcome: ProofCCleanupOutcome = {
          retainedForUnresolved: [...(stored?.authoritiesRetainedForUnresolvedPayments ?? [])],
          warningCount: Array.isArray(stored?.warnings) ? stored.warnings.length : 0,
        };
        evidence = applyCleanupOutcome(evidence, outcome);
      }
    } catch (cleanupError) {
      cleanupFailed = true;
      failure ??= cleanupError instanceof Error ? cleanupError : new Error("Payment proof C cleanup failed.");
      process.exitCode = 1;
    }
    // final evidence persistence must never prevent the run from being closed and the
    // signal handlers removed; unresolved evidence is preserved and no user lock or
    // receipt is ever deleted to force a retry
    try {
      if (evidence) {
        // even a thrown cleanup must leave the evidence consistently FAILED/INCONCLUSIVE
        if (cleanupFailed) evidence = cleanupFailedEvidence(evidence);
        run.report.results.proofC = evidence;
        try {
          await run.save();
          console.log(JSON.stringify({ event: "payment-proof-c-result", status: evidence.status, reason: evidence.reason }));
        } catch (persistError) {
          failure ??= persistError instanceof Error ? persistError : new Error("Payment proof C could not save its result.");
          process.exitCode = 1;
        }
        if (evidence.status !== "PASSED") process.exitCode = 1;
      }
    } catch (persistError) {
      failure ??= persistError instanceof Error ? persistError : new Error("Payment proof C could not persist its result.");
      process.exitCode = 1;
    }
    try {
      await run.finish(failure);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      // releasing this run's own lock is not deleting user state; receipts untouched
      try {
        await run.close();
      } catch (closeError) {
        failure ??= closeError instanceof Error ? closeError : new Error("Payment proof C could not release its run lock.");
        process.exitCode = 1;
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new ProofCCliUsageError("Payment proof C is a development-only experiment and must not run in production mode.");
  }
  const arg = process.argv[2]?.trim().toLowerCase() ?? "";
  if (arg === "" || arg === "dry") return dryStatus();
  if (arg === "--live") return liveProofC();
  throw new ProofCCliUsageError("Run 'npm run payment:proof-c' for the dry NOT_RUN status, or 'npm run payment:proof-c -- --live' for the owner-approved live run.");
}

// the outermost sink cannot leak free-form SDK/provider text: only the locally-created
// config and usage error messages are echoed, everything else uses a constant fallback
void main().catch((error: unknown) => {
  const safe =
    error instanceof ProofCConfigError ? error.message :
    error instanceof ProofCCliUsageError ? error.message :
    "Payment proof C could not start.";
  console.error(JSON.stringify({ event: "payment-proof-c-error", message: safe }));
  process.exitCode = 1;
});
