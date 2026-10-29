import { config as loadDotenv } from "dotenv";

import {
  OpenPaymentsClientError,
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  type AuthenticatedClient,
  type Grant,
  type GrantRequest,
  type GrantWithAccessToken,
} from "@interledger/open-payments";

import { requestInteractiveGrant, testWalletUrl } from "../services/grant-interaction";
import { createOpenPaymentsClient, lookupWalletAddresses } from "../services/open-payments";
import {
  formatAmount,
  ProofRun,
  readProofConfig,
  type Amount,
} from "../services/payment-proof-run";
import { sanitizedProviderCode } from "../services/payment-proof-c";
import { validateReturnedOutgoingGrant } from "../services/outgoing-grant-validation";
import type { WalletAddress } from "@interledger/open-payments";

export type Outcome = "OBTAINED" | "ROTATED" | "REJECTED" | "REVOKED" | "SKIPPED_NO_MANAGE_URI" | "INCONCLUSIVE";

export interface ProbeToken {
  label: string;
  value: string;
  manage?: string;
  advertisedExpiresIn?: number;
}

type TokenLike = { value: string; manage?: string; expires_in?: number };

export interface ProbeStep {
  stage: string;
  expected: Outcome | null;
  outcome: Outcome;
  [detail: string]: unknown;
}

/* run one lifecycle call and record what actually happened next to what we expected */
async function recordStep(
  run: ProofRun,
  steps: ProbeStep[],
  stage: string,
  expected: Outcome,
  operation: () => Promise<Outcome | void>,
): Promise<Outcome> {
  const observed = await operation().catch((error: unknown) => {
    if (error instanceof OpenPaymentsClientError) {
      const status = error.status;
      const definitive = typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && !error.validationErrors?.length;
      const code = sanitizedProviderCode(error.code);
      return {
        outcome: (definitive ? "REJECTED" : "INCONCLUSIVE") as Outcome,
        ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}),
        ...(code === undefined ? {} : { providerCode: code }),
      };
    }
    return { outcome: "INCONCLUSIVE" as Outcome };
  });
  const outcome = observed && typeof observed === "object" && "outcome" in observed
    ? (observed as { outcome: Outcome }).outcome
    : ((observed as Outcome | undefined) ?? expected);
  const result: ProbeStep = { stage, expected, outcome };
  if (observed && typeof observed === "object") Object.assign(result, observed);
  result.outcome = outcome;
  result.matchesExpectation = outcome === expected;
  steps.push(result);
  console.log(JSON.stringify({ event: "token-probe-step", ...result }));
  return outcome;
}

function pushSteps(run: ProofRun, steps: ProbeStep[]): void {
  const existing = run.report.results.tokenProbe as Record<string, unknown> | undefined ?? {};
  run.report.results.tokenProbe = { ...existing, steps: [...((existing.steps as ProbeStep[]) ?? []), ...steps] };
}

function probeCompletedExpectedSteps(run: ProofRun): boolean {
  const probe = run.report.results.tokenProbe as { steps?: ProbeStep[] } | undefined;
  return Boolean(probe?.steps?.length) && !probe!.steps!.some((step) => step.expected !== null && step.outcome !== step.expected);
}

/* a small fixed-debit outgoing request bound to nothing, like Proof B's budget grant */
function outgoingAccess(identifier: string, requestedBudget: Amount): NonNullable<GrantRequest["access_token"]> {
  return {
    access: [{
      type: "outgoing-payment",
      actions: ["create", "read"],
      identifier,
      limits: { debitAmount: requestedBudget },
    }],
  };
}

function tokenFrom(run: ProofRun, tokenLike: TokenLike, label: string): ProbeToken {
  if (typeof tokenLike !== "object" || tokenLike === null) throw new Error("The provider returned no usable token.");
  if (typeof tokenLike.value === "string") run.rememberSecret(tokenLike.value);
  if (typeof tokenLike.manage === "string") run.rememberSecret(tokenLike.manage);
  if (typeof tokenLike.value !== "string" || tokenLike.value === "") throw new Error("The provider returned no usable token value.");
  if (tokenLike.manage !== undefined) {
    if (typeof tokenLike.manage !== "string" || tokenLike.manage === "") throw new Error("The provider returned an invalid token management URI.");
    testWalletUrl(tokenLike.manage);
  }
  if (tokenLike.expires_in !== undefined && (typeof tokenLike.expires_in !== "number" || !Number.isFinite(tokenLike.expires_in) || tokenLike.expires_in <= 0)) {
    throw new Error("The provider returned an invalid advertised token lifetime.");
  }
  const token: ProbeToken = {
    label,
    value: tokenLike.value,
    ...(tokenLike.manage ? { manage: tokenLike.manage } : {}),
    ...(tokenLike.expires_in !== undefined ? { advertisedExpiresIn: tokenLike.expires_in } : {}),
  };
  return token;
}

async function rotate(run: ProofRun, client: AuthenticatedClient, token: ProbeToken): Promise<ProbeToken> {
  if (!token.manage) throw new Error("The provider did not supply a token manage URI for rotation.");
  // some providers wrap the rotated token under access_token, some return it bare
  const response = await client.token.rotate({ url: testWalletUrl(token.manage), accessToken: token.value }) as unknown;
  if (typeof response !== "object" || response === null) throw new Error("The provider returned no usable rotation response.");
  const wrapped = response as Record<string, unknown>;
  const source = (wrapped.access_token ?? wrapped) as TokenLike;
  const result = tokenFrom(run, source, token.label);
  if (result.value === token.value) throw new Error("The provider returned the same token after rotation; replacement is unconfirmed.");
  console.log(JSON.stringify({
    event: "token-rotated",
    label: result.label,
    returnedToken: {
      hasValue: Boolean(result.value),
      hasManageUri: Boolean(result.manage),
      advertisedExpiresIn: result.advertisedExpiresIn ?? null,
    },
  }));
  return result;
}

async function revoke(run: ProofRun, client: AuthenticatedClient, token: ProbeToken): Promise<void> {
  if (!token.manage) throw new Error("The provider did not supply a token manage URI for revocation.");
  await client.token.revoke({ url: testWalletUrl(token.manage), accessToken: token.value });
  console.log(JSON.stringify({ event: "token-revoked", label: token.label }));
}

/* Cancel every retained grant; report failure without exposing provider text or URIs. */
export async function cancelContinuations(run: ProofRun, client: AuthenticatedClient, grants: Grant[]): Promise<number> {
  let warnings = 0;
  for (const grant of grants) {
    try {
      run.rememberSecret(grant.continue.access_token.value);
      run.rememberSecret(grant.continue.uri);
      await client.grant.cancel({
        url: testWalletUrl(grant.continue.uri),
        accessToken: grant.continue.access_token.value,
      });
      console.log(JSON.stringify({ event: "token-probe-grant-cancelled" }));
    } catch {
      warnings += 1;
      console.error(JSON.stringify({ event: "token-probe-cancel-warning", message: "A temporary grant could not be cancelled." }));
    }
  }
  return warnings;
}

/* full rotate/revoke lifecycle over one access token */
export async function probeLifecycle(run: ProofRun, client: AuthenticatedClient, steps: ProbeStep[], initial: ProbeToken): Promise<void> {
  const label = initial.label;

  steps.push({
    stage: `${label}: inspect initial token`,
    expected: null,
    outcome: "OBTAINED",
    hasManageUri: Boolean(initial.manage),
    advertisedExpiresIn: initial.advertisedExpiresIn ?? null,
  });
  try {
    if (!initial.manage) {
      steps.push({ stage: `${label}: rotate once`, expected: "ROTATED", outcome: "SKIPPED_NO_MANAGE_URI" });
      return;
    }
    let current = initial;
    const previousExpiry = initial.advertisedExpiresIn ?? null;
    const first = await recordStep(run, steps, `${label}: rotate once`, "ROTATED", async () => {
      current = await rotate(run, client, current);
    });
    if (first !== "ROTATED") return;
    console.log(JSON.stringify({
      event: "token-probe-expiry-comparison",
      label,
      advertisedExpiresInBefore: previousExpiry,
      advertisedExpiresInAfterRotation: current.advertisedExpiresIn ?? null,
    }));

    // A failed/ambiguous rotation stops the probe. Do not replace the current
    // token with an unexpected replay response or continue on uncertain state.
    const replay = await recordStep(run, steps, `${label}: old token must stop working`, "REJECTED", async () => {
      await rotate(run, client, initial);
      return "ROTATED";
    });
    if (replay !== "REJECTED") return;

    const revoked = await recordStep(run, steps, `${label}: revoke current token`, "REVOKED", async () => {
      await revoke(run, client, current);
    });
    if (revoked !== "REVOKED") return;
    await recordStep(run, steps, `${label}: revoked token must stop working`, "REJECTED", async () => {
      await rotate(run, client, current);
      return "ROTATED";
    });
  } finally {
    pushSteps(run, steps);
  }
}

/* consent-free run against a non-interactive resource grant */
async function probeResource(
  run: ProofRun,
  client: AuthenticatedClient,
  grants: Grant[],
  receiver: WalletAddress,
): Promise<void> {
  const steps: ProbeStep[] = [
    { stage: "request non-interactive incoming-payment grant", expected: "OBTAINED", outcome: "OBTAINED", tokenType: "incoming-payment", interactiveApprovals: 0 },
  ];
  const grant = await run.step("token probe: request non-interactive incoming-payment grant", async () => {
    const requested = await client.grant.request({
      url: testWalletUrl(receiver.authServer),
    }, {
      access_token: {
        access: [{ type: "incoming-payment", actions: ["create", "read", "complete"], identifier: receiver.id }],
      },
    });
    grants.push(requested);
    return requested;
  });
  if (!isFinalizedGrantWithAccessToken(grant)) {
    steps[0] = {
      stage: "request non-interactive incoming-payment grant",
      expected: "OBTAINED",
      outcome: "SKIPPED_NO_MANAGE_URI",
      tokenType: "incoming-payment",
      interactiveApprovals: 0,
      reason: "The provider required an interaction for the resource token in this run.",
    };
    pushSteps(run, steps);
    return;
  }
  const token = tokenFrom(run, grant.access_token, "resource");
  await probeLifecycle(run, client, steps, token);
}

/* one consent click, then a full rotate/revoke cycle over a spending token */
async function probeOutgoing(
  run: ProofRun,
  client: AuthenticatedClient,
  grants: Grant[],
  config: ReturnType<typeof readProofConfig>,
  budget: Amount,
  sender: WalletAddress,
): Promise<void> {
  const steps: ProbeStep[] = [
    { stage: "request interactive outgoing grant", expected: "OBTAINED", outcome: "OBTAINED", tokenType: "outgoing-payment", interactiveApprovals: 1 },
  ];
  const grant = await run.step("token probe: request interactive outgoing grant", async () =>
    requestInteractiveGrant(
      client,
      sender.authServer,
      outgoingAccess(sender.id, budget),
      {
        port: config.callbackPort,
        timeoutMs: config.consentTimeoutMs,
        signal: run.controller.signal,
        rememberSecret: (value) => run.rememberSecret(value),
        onCleanupWarning: () => {
          console.error(JSON.stringify({ event: "token-probe-cleanup-warning", message: "The unfinished grant could not be cancelled." }));
        },
        onRedirect: async (url) => {
          run.report.status = "WAITING_FOR_CONSENT";
          await run.save();
          console.log(JSON.stringify({ event: "approval-required", probe: "token-renewal", budget: formatAmount(budget), url }));
        },
      },
    ));
  if (isPendingGrant(grant) || !isFinalizedGrantWithAccessToken(grant)) {
    steps[0] = {
      ...steps[0],
      outcome: "SKIPPED_NO_MANAGE_URI",
      reason: "The provider did not finalize the interactive outgoing grant in this run.",
    };
    pushSteps(run, steps);
    return;
  }
  grants.push(grant);
  // Register every authority before validation; rejected issued grants still
  // remain in `grants` for cleanup. Never trust wider or malformed permissions.
  run.rememberSecret(grant.continue.uri);
  run.rememberSecret(grant.continue.access_token.value);
  const token = tokenFrom(run, grant.access_token, "outgoing");
  validateReturnedOutgoingGrant(grant, { payerId: sender.id, requestedDebit: budget });
  await probeLifecycle(run, client, steps, token);
}

async function main(): Promise<void> {
  loadDotenv();
  const arg = process.argv[2] ?? "resource";
  if (arg !== "resource" && arg !== "outgoing" && arg !== "all") {
    throw new Error("Choose token probe mode: resource, outgoing or all.");
  }
  const config = readProofConfig();
  console.error(JSON.stringify({
    event: "token-probe-config",
    consentTimeoutMs: config.consentTimeoutMs,
    callbackPort: config.callbackPort,
  }));

  const run = new ProofRun("token-probe");
  await run.start();
  const interrupt = () => run.controller.abort(new Error("Token probe interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const grants: Grant[] = [];
  let client: AuthenticatedClient | undefined;
  let failure: unknown;
  try {
    const senderUrl = process.env.SENDING_WALLET_ADDRESS_URL?.trim();
    const receiverUrl = process.env.RECEIVING_WALLET_ADDRESS_URL?.trim();
    if (!senderUrl || !receiverUrl) throw new Error("Configure both temporary proof wallet addresses in backend/.env.");
    run.report.results.tokenProbe = { mode: arg, steps: [] };

    let sender!: WalletAddress;
    let receiver!: WalletAddress;
    await run.step("token probe: fetch wallet metadata", async () => {
      [sender, receiver] = await lookupWalletAddresses([senderUrl, receiverUrl]);
      if (sender.id === receiver.id) throw new Error("The token probe requires distinct payer and recipient wallet addresses.");
      for (const wallet of [sender, receiver]) {
        testWalletUrl(wallet.id);
        testWalletUrl(wallet.authServer);
        testWalletUrl(wallet.resourceServer);
      }
      run.report.results.wallets = {
        sender: { id: sender.id, assetCode: sender.assetCode, assetScale: sender.assetScale },
        receiver: { id: receiver.id, assetCode: receiver.assetCode, assetScale: receiver.assetScale },
      };
    });

    const established = await run.step("token probe: initialize signing client", () => createOpenPaymentsClient());
    client = established;

    if (arg === "resource" || arg === "all") {
      await probeResource(run, client, grants, receiver);
      if (!probeCompletedExpectedSteps(run)) throw new Error("The resource token lifecycle did not complete as expected.");
    }
    if (arg === "outgoing" || arg === "all") {
      await probeOutgoing(run, client, grants, config, { assetCode: sender.assetCode, assetScale: sender.assetScale, value: config.budgetMinor }, sender);
    }
    if (!probeCompletedExpectedSteps(run)) {
      failure = new Error("The token probe did not complete all expected lifecycle checks.");
      process.exitCode = 1;
    }
  } catch {
    failure = new Error("The token probe stopped before completing its lifecycle checks.");
    process.exitCode = 1;
  } finally {
    try {
      const warnings = client ? await cancelContinuations(run, client, grants) : 0;
      run.report.results.tokenProbeCleanup = { warnings };
      if (warnings > 0) {
        failure ??= new Error("The token probe could not cancel every temporary grant.");
        process.exitCode = 1;
      }
    } catch {
      failure ??= new Error("Token probe cleanup failed.");
      process.exitCode = 1;
      console.error(JSON.stringify({ event: "token-probe-cleanup-warning", message: "Token probe cleanup could not finish." }));
    }
    try {
      await run.finish(failure);
    } finally {
      try {
        await run.close();
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error("The token probe could not start or finalize.");
    process.exitCode = 1;
  });
}
