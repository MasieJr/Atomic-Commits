import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";

import { PaymentProofs, type ApprovedSpending } from "../services/payment-proof";
import { minorValue, ProofRun, readProofConfig, type Amount, type ProofMode } from "../services/payment-proof-run";

// one payment, with approval limited to its quote and incoming receiver
async function proofA(proofs: PaymentProofs): Promise<void> {
  const payment = await proofs.prepare("A-payment");
  const grant = await proofs.authorize("A", payment.quote.debitAmount, payment.incoming.id);
  const evidence = await proofs.pay(payment, grant, grant.budget);
  const result = {
    status: "PASSED",
    runId: proofs.run.report.runId,
    sender: proofs.sender.id,
    receiver: proofs.receiver.id,
    grantReference: grant.grant.continue.uri,
    interactiveApprovals: 1,
    payment: evidence,
  };
  proofs.run.report.results.proofA = result;
  await proofs.run.writeReceipt("a", result);
  await proofs.run.save();
  console.log(JSON.stringify({ event: "proof-a-passed", outgoingPaymentId: evidence.outgoingPaymentId }));
}

// the provider counter can catch up after the transfer completes
async function waitForSpent(proofs: PaymentProofs, grant: ApprovedSpending, expected: bigint): Promise<Amount> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const amount = await proofs.spent(grant);
    if (amount && minorValue(amount.value) === expected) return amount;
    if (amount && minorValue(amount.value) > expected) throw new Error("Provider grant spending exceeds these proof payments.");
    await delay(1000);
  }
  throw new Error("The provider's spent counter did not confirm the settled proof amounts.");
}

async function performProofB(proofs: PaymentProofs): Promise<void> {
  const receipt = await proofs.run.readReceipt("a").catch(() => {
    throw new Error("Complete Proof A first, or run payment:proofs to execute both in order.");
  });
  if (receipt.status !== "PASSED" || receipt.sender !== proofs.sender.id || receipt.receiver !== proofs.receiver.id) {
    throw new Error("Proof A has not passed for the currently configured wallets.");
  }

  // approve the budget first; create the receiving resources after consent
  const grant = await proofs.authorize("B", proofs.budgetAmount());
  const originalToken = grant.grant.access_token.value;
  const initialSpent = await proofs.spent(grant);
  if (initialSpent && minorValue(initialSpent.value) !== 0n) {
    throw new Error("The new grant already reports spending, so this experiment is not isolated.");
  }
  const confirmed = [];
  let expected = 0n;
  let spent: Amount = { ...grant.budget, value: "0" };
  for (let index = 1; index <= 2; index++) {
    // same outgoing grant/token, fresh incoming payment and quote each time
    const remaining = { ...grant.budget, value: (minorValue(grant.budget.value) - minorValue(spent.value)).toString() };
    const payment = await proofs.prepare(`B-payment-${index}`);
    const evidence = await proofs.pay(payment, grant, remaining);
    if (grant.grant.access_token.value !== originalToken) throw new Error("The outgoing grant token changed during the reuse experiment.");
    confirmed.push(evidence);
    expected += minorValue(evidence.quotedDebit.value);
    spent = await waitForSpent(proofs, grant, expected);
  }
  proofs.run.report.results.proofB = {
    status: "PAYMENTS_CONFIRMED_CHECKING_BUDGET",
    grantReference: grant.grant.continue.uri,
    sameGrantAndToken: true,
    reuseStatus: "PASSED",
    interactiveApprovals: 1,
    providerSpentDebitAmount: spent,
    recipientCoverage: "Two fresh payments to the same merchant wallet; a second merchant is not covered by this proof.",
    payments: confirmed,
  };
  await proofs.run.save();

  // having allowance left must not let a request exceed the aggregate cap
  await proofs.probeBudget(grant, spent, confirmed[0].quotedDebit);
  const result = {
    ...proofs.run.report.results.proofB as Record<string, unknown>,
    status: "PASSED",
    goNoGo: "REUSABLE_GRANT_DEMONSTRATED_FOR_THIS_WALLET_PAIR",
    offlineRedemptionImplemented: false,
    sender: proofs.sender.id,
    receiver: proofs.receiver.id,
    runId: proofs.run.report.runId,
    budgetEnforcement: proofs.run.report.results.budgetEnforcement,
    limitations: "Provider token expiry/refresh and multi-merchant behavior require separate lifecycle checks before production use.",
  };
  proofs.run.report.results.proofB = result;
  await proofs.run.writeReceipt("b", result);
  await proofs.run.save();
  console.log(JSON.stringify({ event: "proof-b-passed", sameGrantAndToken: true, providerSpentDebitAmount: spent }));
}

async function proofB(proofs: PaymentProofs): Promise<void> {
  // keep a clear capability result even if the experiment stops halfway
  proofs.run.report.results.proofB = { status: "IN_PROGRESS", offlineRedemptionImplemented: false };
  await proofs.run.save();
  try {
    await performProofB(proofs);
  } catch (error) {
    const current = proofs.run.report.results.proofB as Record<string, unknown>;
    proofs.run.report.results.proofB = {
      ...current,
      status: "NOT_DEMONSTRATED",
      budgetEnforcement: proofs.run.report.results.budgetEnforcement ?? null,
      goNoGo: "NO_GO_FOR_OFFLINE_PAYER_DEMO_UNTIL_THIS_IS_RESOLVED",
      error: proofs.run.safeError(error),
      fallback: "Complete/use Proof A's online provider-approved flow while resolving this provider/configuration result.",
    };
    await proofs.run.save();
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "a" && mode !== "b" && mode !== "both") throw new Error("Choose proof a, b or both.");
  const config = readProofConfig();
  const run = new ProofRun(mode as ProofMode);
  await run.start();
  // stop new operations on Ctrl+C; submitted payments may still need checking
  const interrupt = () => run.controller.abort(new Error("Payment proof interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let proofs: PaymentProofs | undefined;
  let failure: unknown;
  try {
    proofs = await PaymentProofs.create(run, config);
    await proofs.initializeResourceGrants();
    if (mode === "a" || mode === "both") await proofA(proofs);
    if (mode === "b" || mode === "both") await proofB(proofs);
  } catch (error) {
    failure = error instanceof Error ? error : new Error("The payment proof failed unexpectedly.");
    if (mode === "both" && !run.report.results.proofB) {
      run.report.results.proofB = { status: "NOT_RUN", reason: "Proof A did not complete successfully." };
    }
    process.exitCode = 1;
  } finally {
    try {
      // cancel temporary grants, save the result, then release the run lock
      try {
        await proofs?.cleanup();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error("Proof cleanup failed.");
        process.exitCode = 1;
      }
      await run.finish(failure);
    } finally {
      await run.close();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Payment proof could not start.");
  process.exitCode = 1;
});
