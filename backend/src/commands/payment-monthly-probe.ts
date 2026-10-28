import { config as loadDotenv } from "dotenv";

import { observeMonthlyGrant } from "../dev/monthly-grant-probe";
import { requestInteractiveGrant, testWalletUrl } from "../services/grant-interaction";
import { createOpenPaymentsClient, lookupWalletAddresses } from "../services/open-payments";
import { finalizeProofCRun } from "../services/payment-proof-c-finalization";
import { ProofRun, readProofConfig } from "../services/payment-proof-run";

async function live(): Promise<void> {
  loadDotenv();
  const runtime = readProofConfig();
  const run = new ProofRun("monthly-probe");
  await run.start();
  const interrupt = () => run.controller.abort(new Error("Monthly grant probe interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let failure: Error | undefined;
  let unfinishedCleanupWarning = false;
  try {
    const senderUrl = process.env.SENDING_WALLET_ADDRESS_URL?.trim();
    if (!senderUrl) throw new Error("The Test Wallet payer is not configured.");
    // Validate the configured address before even the public wallet metadata lookup.
    testWalletUrl(senderUrl.startsWith("$") ? `https://${senderUrl.slice(1)}` : senderUrl);
    const clientWalletUrl = process.env.CLIENT_WALLET_ADDRESS_URL?.trim();
    if (!clientWalletUrl) throw new Error("The Test Wallet client identity is not configured.");
    testWalletUrl(clientWalletUrl.startsWith("$") ? `https://${clientWalletUrl.slice(1)}` : clientWalletUrl);
    const [sender] = await run.step("monthly probe: fetch Test Wallet metadata", () => lookupWalletAddresses([senderUrl]));
    for (const url of [sender.id, sender.authServer, sender.resourceServer]) testWalletUrl(url);
    if (sender.assetCode !== "ZAR" || sender.assetScale !== 2) throw new Error("This probe requires a ZAR Test Wallet with scale 2.");
    const client = await run.step("monthly probe: initialize signing client", () => createOpenPaymentsClient());

    const result = await observeMonthlyGrant({
      request: (interval, debit) => run.step("monthly probe: request interactive grant", async () => {
        const grant = await requestInteractiveGrant(client, sender.authServer, {
          access: [{
            type: "outgoing-payment", actions: ["create", "read"], identifier: sender.id,
            limits: { debitAmount: debit, interval },
          }],
        }, {
          port: runtime.callbackPort,
          timeoutMs: runtime.consentTimeoutMs,
          signal: run.controller.signal,
          rememberSecret: (value) => run.rememberSecret(value),
          onCleanupWarning: () => { unfinishedCleanupWarning = true; },
          onRedirect: async (url) => {
            run.rememberSecret(url);
            run.report.status = "WAITING_FOR_CONSENT";
            await run.save();
            console.log(JSON.stringify({ event: "approval-required", probe: "monthly-grant", debit, interval, url }));
          },
        });
        // Register the continuation URI before any observation or cleanup.
        if (typeof grant.continue?.uri === "string") run.rememberSecret(grant.continue.uri);
        return grant;
      }),
      readSpent: (accessToken) => run.step("monthly probe: read initial spent amounts", () => client.outgoingPayment.getGrantSpentAmounts({
        url: sender.resourceServer, accessToken,
      })),
      cancel: async (grant) => {
        await client.grant.cancel({
          url: testWalletUrl(grant.continue.uri),
          accessToken: grant.continue.access_token.value,
        });
      },
    }, sender.id, new Date());

    // Even a clean response proves only immediate scope observation and cancellation.
    const evidence = { ...result, unfinishedCleanupWarning, outgoingPayments: 0, monthLifetimeVerified: false, monthlyResetVerified: false };
    run.report.results.monthlyProbe = evidence;
    if (result.status !== "OBSERVED" || unfinishedCleanupWarning) {
      failure = new Error("Monthly probe was inconclusive or cleanup could not be confirmed.");
      process.exitCode = 1;
    }
    console.log(JSON.stringify({ event: "monthly-probe-result", ...evidence }));
  } catch {
    failure = new Error("Monthly probe could not complete; inspect the sanitized run record.");
    process.exitCode = 1;
  } finally {
    const finalization = await finalizeProofCRun(run, failure, () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    });
    if (finalization.finishFailed || finalization.signalCleanupFailed || finalization.closeFailed) {
      console.error(JSON.stringify({ event: "monthly-probe-finalization-error", message: "The report or run lock could not be finalized." }));
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("The monthly grant probe is development-only.");
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "dry" && args[0] !== "--live")) {
    throw new Error("Run without arguments for dry mode or use --live after explicit approval.");
  }
  if (args[0] !== "--live") {
    console.log(JSON.stringify({
      event: "monthly-probe", status: "NOT_RUN", live: false,
      requestedDebit: { value: "1", assetCode: "ZAR", assetScale: 2 },
      requestedInterval: "R1/<current-UTC-start>/P1M", outgoingPayments: 0,
      note: "Live mode requests one grant and consent, reads its initial counter only if scope matches, then cancels it.",
    }));
    return;
  }
  await live();
}

if (require.main === module) {
  void main().catch(() => {
    console.error(JSON.stringify({ event: "monthly-probe-error", message: "The monthly probe could not start or finalize." }));
    process.exitCode = 1;
  });
}
