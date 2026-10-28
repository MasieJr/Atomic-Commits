import {
  OpenPaymentsClientError,
  isFinalizedGrantWithAccessToken,
  type AuthenticatedClient,
  type Grant,
  type GrantWithAccessToken,
  type IncomingPayment,
  type Quote,
  type WalletAddress,
} from "@interledger/open-payments";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { requestInteractiveGrant, testWalletUrl } from "./grant-interaction";
import { validateReturnedOutgoingGrant } from "./outgoing-grant-validation";
import { createOpenPaymentsClient, lookupWalletAddresses } from "./open-payments";
import {
  formatAmount,
  minorValue,
  ProofRun,
  ProofStepError,
  sameAsset,
  type Amount,
  type PaymentEvidence,
  type ProofConfig,
} from "./payment-proof-run";

export interface PreparedPayment {
  incoming: IncomingPayment;
  quote: Quote;
  evidence: PaymentEvidence;
}

export interface ApprovedSpending {
  grant: GrantWithAccessToken;
  budget: Amount;
  expiresAt?: number;
}

function underlying(error: unknown): unknown {
  return error instanceof ProofStepError ? error.original : error;
}

// timeouts and invalid responses are unclear, so don't treat them as a safe retry
function definitiveRejection(error: unknown): boolean {
  const value = underlying(error);
  return value instanceof OpenPaymentsClientError &&
    value.status !== undefined && value.status >= 400 && value.status < 500 &&
    value.status !== 408 && !value.validationErrors?.length;
}

// shared provider calls for A and B
export class PaymentProofs {
  private readonly grants: { continuation: Grant["continue"]; purpose: "incoming" | "quote" | "outgoing" }[] = [];
  private incomingGrant!: GrantWithAccessToken;
  private quoteGrant!: GrantWithAccessToken;

  private constructor(
    readonly run: ProofRun,
    readonly config: ProofConfig,
    readonly client: AuthenticatedClient,
    readonly sender: WalletAddress,
    readonly receiver: WalletAddress,
  ) {}

  // load the demo wallets and build one signing client for this run
  static async create(run: ProofRun, config: ProofConfig): Promise<PaymentProofs> {
    const senderUrl = process.env.SENDING_WALLET_ADDRESS_URL?.trim();
    const receiverUrl = process.env.RECEIVING_WALLET_ADDRESS_URL?.trim();
    if (!senderUrl || !receiverUrl) throw new Error("Configure both temporary proof wallet addresses in backend/.env.");
    const [sender, receiver] = await run.step("fetch Test Wallet metadata", () => lookupWalletAddresses([senderUrl, receiverUrl]));
    if (sender.id === receiver.id) throw new Error("Payment proofs require distinct payer and recipient wallet addresses.");
    for (const wallet of [sender, receiver]) {
      testWalletUrl(wallet.id);
      testWalletUrl(wallet.authServer);
      testWalletUrl(wallet.resourceServer);
    }
    const client = await run.step("initialize signing client", () => createOpenPaymentsClient());
    const proofs = new PaymentProofs(run, config, client, sender, receiver);
    run.report.results.wallets = {
      sender: { id: sender.id, assetCode: sender.assetCode, assetScale: sender.assetScale },
      receiver: { id: receiver.id, assetCode: receiver.assetCode, assetScale: receiver.assetScale },
    };
    console.log(JSON.stringify({ event: "proof-amounts", receive: formatAmount(proofs.receiveAmount()), maximumDebitBudget: formatAmount(proofs.budgetAmount()) }));
    return proofs;
  }

  // what the recipient gets, using their asset and scale
  receiveAmount(): Amount {
    return { assetCode: this.receiver.assetCode, assetScale: this.receiver.assetScale, value: this.config.receiveMinor };
  }

  // what the payer can spend, using the payer's asset and scale
  budgetAmount(): Amount {
    return { assetCode: this.sender.assetCode, assetScale: this.sender.assetScale, value: this.config.budgetMinor };
  }

  private rememberGrant(grant: Grant, purpose: "incoming" | "quote" | "outgoing"): void {
    // keep tokens and management/continuation references out of reports, and retain what we need to cancel later
    this.run.rememberSecret(grant.continue.access_token.value);
    if (grant.access_token) {
      this.run.rememberSecret(grant.access_token.value);
      this.run.rememberSecret(grant.access_token.manage);
    }
    // even the continuation URI is treated as redactable evidence; references stay opaque
    this.run.rememberSecret(grant.continue.uri);
    this.grants.push({ continuation: grant.continue, purpose });
  }

  // these grants let us prepare/read resources; spending approval comes later.
  // this stays non-interactive and re-invocable: refreshing resource tokens later is
  // a maintenance read/write on existing wallets, never new outgoing payment consent.
  async initializeResourceGrants(): Promise<void> {
    const incoming = await this.run.step("request recipient incoming-payment grant", () => this.client.grant.request({
      url: this.receiver.authServer,
    }, { access_token: { access: [{ type: "incoming-payment", actions: ["create", "read", "complete"] }] } }));
    this.rememberGrant(incoming, "incoming");
    if (!isFinalizedGrantWithAccessToken(incoming)) throw new Error("The recipient incoming-payment grant requires an unsupported extra interaction.");
    this.incomingGrant = incoming;

    const quote = await this.run.step("request payer quote grant", () => this.client.grant.request({
      url: this.sender.authServer,
    }, { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } }));
    this.rememberGrant(quote, "quote");
    if (!isFinalizedGrantWithAccessToken(quote)) throw new Error("The quote grant requires an unsupported extra interaction.");
    this.quoteGrant = quote;
  }

  // seam: re-run the non-interactive resource-grant maintenance over a long proof when the
  // incoming/quote tokens lapse. this only refreshes existing resource wallets and never
  // requests, renews or widens outgoing payment consent.
  async refreshResourceGrants(): Promise<void> {
    await this.initializeResourceGrants();
  }

  // give each payment its own incoming resource and quote
  async prepare(label: string, fixedDebit?: Amount): Promise<PreparedPayment> {
    const incoming = await this.run.step(`${label}: create fresh incoming payment`, () => this.client.incomingPayment.create({
      url: this.receiver.resourceServer,
      accessToken: this.incomingGrant.access_token.value,
    }, {
      walletAddress: this.receiver.id,
      ...(fixedDebit ? {} : { incomingAmount: this.receiveAmount() }),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      metadata: { description: `Atomic Commits Test Wallet ${label}`, proofRun: this.run.report.runId },
    }));
    testWalletUrl(incoming.id);
    if (incoming.walletAddress !== this.receiver.id) throw new Error("The provider returned an incoming payment for a different recipient.");
    const quote = await this.createQuote(label, incoming.id, fixedDebit);
    const evidence: PaymentEvidence = {
      label,
      state: "PREPARED",
      incomingPaymentId: incoming.id,
      quoteId: quote.id,
      quotedDebit: quote.debitAmount,
      quotedReceive: quote.receiveAmount,
    };
    this.run.report.payments.push(evidence);
    await this.run.save();
    console.log(JSON.stringify({ event: "quote", label, quoteId: quote.id, debit: formatAmount(quote.debitAmount), receive: formatAmount(quote.receiveAmount) }));
    return { incoming, quote, evidence };
  }

  // let the provider price the transfer, including conversion and fees
  private async createQuote(label: string, incomingId: string, fixedDebit?: Amount): Promise<Quote> {
    const quote = await this.run.step(`${label}: create fresh quote`, () => this.client.quote.create({
      url: this.sender.resourceServer,
      accessToken: this.quoteGrant.access_token.value,
    }, {
      walletAddress: this.sender.id,
      receiver: incomingId,
      method: "ilp",
      ...(fixedDebit ? { debitAmount: fixedDebit } : {}),
    }));
    testWalletUrl(quote.id);
    if (quote.walletAddress !== this.sender.id || quote.receiver !== incomingId ||
      !sameAsset(quote.debitAmount, this.budgetAmount()) || !sameAsset(quote.receiveAmount, this.receiveAmount()) ||
      minorValue(quote.debitAmount.value) <= 0n || minorValue(quote.receiveAmount.value) <= 0n) {
      throw new Error("The provider quote does not match the intended payer, recipient or assets.");
    }
    if (fixedDebit && minorValue(quote.debitAmount.value) !== minorValue(fixedDebit.value)) {
      throw new Error("The provider did not preserve the fixed debit amount.");
    }
    if (!fixedDebit && minorValue(quote.receiveAmount.value) !== minorValue(this.config.receiveMinor)) {
      throw new Error("The provider did not quote the requested receive amount.");
    }
    return quote;
  }

  // single grant-request policy, shared by every path that obtains outgoing consent:
  // only positive amounts in the payer wallet's asset, at or below the configured proof
  // budget, are ever requested or installed
  private requireValidGrantRequest(requestedBudget: Amount): void {
    if (!sameAsset(requestedBudget, this.budgetAmount()) ||
      minorValue(requestedBudget.value) === 0n ||
      minorValue(requestedBudget.value) > minorValue(this.config.budgetMinor)) {
      throw new Error("The requested grant exceeds the configured proof budget, is not positive, or uses a different asset.");
    }
  }

  // get payer approval for this cap; A binds a receiver, B leaves it open
  async authorize(label: string, requestedBudget: Amount, receiver?: string): Promise<ApprovedSpending> {
    // validate the request too, before asking the provider for anything
    this.requireValidGrantRequest(requestedBudget);
    console.log(JSON.stringify({ event: "grant-request", label, budget: formatAmount(requestedBudget), receiverBinding: receiver ?? "none" }));
    const grant = await this.run.step(`${label}: request and continue outgoing grant`, () => requestInteractiveGrant(
      this.client,
      this.sender.authServer,
      { access: [{
        type: "outgoing-payment",
        actions: ["create", "read"],
        identifier: this.sender.id,
        limits: { debitAmount: requestedBudget, ...(receiver ? { receiver } : {}) },
      }] },
      {
        port: this.config.callbackPort,
        timeoutMs: this.config.consentTimeoutMs,
        signal: this.run.controller.signal,
        rememberSecret: (value) => this.run.rememberSecret(value),
        onCleanupWarning: (error) => {
          const safe = this.run.safeError(new ProofStepError(`${label}: cancel unfinished grant`, error));
          const warnings = this.run.report.results.interactionCleanupWarnings;
          this.run.report.results.interactionCleanupWarnings = [...(Array.isArray(warnings) ? warnings : []), safe];
          console.error(JSON.stringify({ event: "grant-cleanup-warning", ...safe }));
        },
        onRedirect: async (url) => {
          this.run.report.status = "WAITING_FOR_CONSENT";
          await this.run.save();
          console.log(JSON.stringify({ event: "approval-required", proof: label, budget: formatAmount(requestedBudget), url }));
        },
      },
    ));
    return this.installOutgoingGrant(label, grant, requestedBudget, receiver);
  }

  // public seam for proof harnesses that obtain the interactive grant themselves (e.g. a
  // token-probe wrapper): the returned authority is validated fail-closed, registered for
  // redaction and later cleanup before validation, tracked in the report and returned as
  // verified spending.
  async installOutgoingGrant(
    label: string,
    grant: GrantWithAccessToken,
    requestedBudget: Amount,
    receiver?: string,
  ): Promise<ApprovedSpending> {
    this.rememberGrant(grant, "outgoing");
    // the public installer enforces the exact same request policy as authorize — including
    // the configured proof budget ceiling — so the installed cap can never exceed it.
    // this runs after rememberGrant so a rejected already-issued grant stays tracked and
    // can still be cancelled during cleanup.
    this.requireValidGrantRequest(requestedBudget);
    // decide what was actually granted before anything uses it; this runs after rememberGrant
    // so a rejected authority stays tracked and can still be cancelled during cleanup
    const returned = validateReturnedOutgoingGrant(grant, {
      payerId: this.sender.id,
      requestedDebit: requestedBudget,
      ...(receiver === undefined ? {} : { requestedReceiver: receiver }),
    });
    // expiry stays a wall-clock check in the wrapper so the helper remains deterministic
    const deadline = Date.now() + returned.expiresInSeconds * 1000;
    // only machine-representable deadlines pass; JS Dates cannot express beyond ~8.64e15 ms
    if (!Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime())) {
      throw new Error("The advertised access-token expiry is too distant to represent a reliable payment deadline.");
    }
    const spending: ApprovedSpending = {
      grant,
      budget: returned.budget,
      expiresAt: deadline,
    };
    this.run.report.results[`${label}Grant`] = {
      // stable opaque identity; the raw continuation URI is a registered secret, never logged
      referenceDigest: createHash("sha256").update(grant.continue.uri).digest("hex").slice(0, 16),
      interactiveApprovals: 1,
      requestedBudget,
      returnedLimits: returned.limits,
      expiresInSeconds: returned.expiresInSeconds,
    };
    await this.run.save();
    return spending;
  }

  private requireLiveGrant(spending: ApprovedSpending): void {
    // leave a small margin instead of starting with an almost-expired token
    if (spending.expiresAt !== undefined && spending.expiresAt <= Date.now() + 5000) {
      throw new Error("The outgoing-payment token expired or is too close to expiry. The proof will not replace it silently.");
    }
  }

  private async refreshQuote(payment: PreparedPayment): Promise<void> {
    // approval can take a while; get a fresh price without raising the grant cap
    if (!payment.quote.expiresAt || Date.parse(payment.quote.expiresAt) > Date.now() + 5000) return;
    payment.quote = await this.createQuote(payment.evidence.label, payment.incoming.id);
    payment.evidence.quoteId = payment.quote.id;
    payment.evidence.quotedDebit = payment.quote.debitAmount;
    payment.evidence.quotedReceive = payment.quote.receiveAmount;
    await this.run.save();
  }

  // final budget/expiry checks before asking the provider to debit
  async pay(
    payment: PreparedPayment,
    spending: ApprovedSpending,
    remainingBudget: Amount,
    perPaymentDebitCeiling?: Amount,
  ): Promise<PaymentEvidence> {
    // synchronous guard before the first await: never re-prepare or re-quote onto an
    // already-submitted payment
    if (payment.evidence.state !== "PREPARED") {
      throw new Error("This payment was already submitted; reconcile the recorded provider attempt instead of debiting again.");
    }
    this.run.controller.signal.throwIfAborted();
    // the caller-supplied remaining budget is never trusted wider than the immutable
    // provider-accepted cap: it must be canonical, use the approved budget's asset/scale,
    // and stay at or below it. this rejection happens with no provider interaction.
    let remaining: bigint;
    try {
      remaining = minorValue(remainingBudget.value);
    } catch {
      throw new Error("The submitted remaining budget is not a canonical nonnegative integer amount.");
    }
    if (!sameAsset(remainingBudget, spending.budget) || remaining > minorValue(spending.budget.value)) {
      throw new Error("The submitted remaining budget is not at or below the approved spending budget.");
    }
    await this.refreshQuote(payment);
    this.requireLiveGrant(spending);
    if (!sameAsset(payment.quote.debitAmount, remainingBudget) ||
      minorValue(payment.quote.debitAmount.value) > minorValue(remainingBudget.value)) {
      throw new Error("The quoted debit exceeds the remaining approved proof budget.");
    }
    // defense in depth: a quoted debit may also never exceed the immutable approved
    // spending budget itself, whatever the submitted remaining amount claimed
    if (!sameAsset(payment.quote.debitAmount, spending.budget) ||
      minorValue(payment.quote.debitAmount.value) > minorValue(spending.budget.value)) {
      throw new Error("The quoted debit exceeds the approved spending budget.");
    }
    // seam for an explicit per-payment payer debit ceiling, independent of the aggregate remaining budget
    if (perPaymentDebitCeiling !== undefined &&
      (!sameAsset(payment.quote.debitAmount, perPaymentDebitCeiling) ||
        minorValue(payment.quote.debitAmount.value) > minorValue(perPaymentDebitCeiling.value))) {
      throw new Error("The quoted payer debit exceeds the explicit per-payment ceiling.");
    }
    return this.submitAndConfirm(payment, spending);
  }

  private async submitAndConfirm(payment: PreparedPayment, spending: ApprovedSpending): Promise<PaymentEvidence> {
    // synchronous guard before the first await: a payment is submitted exactly once, from PREPARED only
    if (payment.evidence.state !== "PREPARED") {
      throw new Error("This payment was already submitted; reconcile the recorded provider attempt instead of debiting again.");
    }
    // save before POST so an unclear response can't trigger a second debit
    payment.evidence.state = "SUBMITTING";
    await this.run.save();
    try {
      const outgoing = await this.run.step(`${payment.evidence.label}: create outgoing payment`, () => this.client.outgoingPayment.create({
        url: this.sender.resourceServer,
        accessToken: spending.grant.access_token.value,
      }, { walletAddress: this.sender.id, quoteId: payment.quote.id }));
      testWalletUrl(outgoing.id);
      payment.evidence.outgoingPaymentId = outgoing.id;
      payment.evidence.state = "PROCESSING";
      await this.run.save();
    } catch (error) {
      payment.evidence.state = definitiveRejection(error) ? "FAILED" : "UNKNOWN";
      await this.run.save();
      throw error;
    }
    return this.confirm(payment, spending);
  }

  // check both sides at the provider before calling the payment successful
  private async confirm(payment: PreparedPayment, spending: ApprovedSpending): Promise<PaymentEvidence> {
    const deadline = Date.now() + this.config.settlementTimeoutMs;
    try {
      return await this.run.step(`${payment.evidence.label}: reconcile provider outcome`, async () => {
        while (Date.now() < deadline) {
          this.run.controller.signal.throwIfAborted();
          this.requireLiveGrant(spending);
          try {
            const [outgoing, incoming] = await Promise.all([
              this.client.outgoingPayment.get({ url: payment.evidence.outgoingPaymentId!, accessToken: spending.grant.access_token.value }),
              this.client.incomingPayment.get({ url: payment.incoming.id, accessToken: this.incomingGrant.access_token.value }),
            ]);
            if (outgoing.walletAddress !== this.sender.id || outgoing.receiver !== payment.incoming.id ||
              outgoing.quoteId !== payment.quote.id || incoming.walletAddress !== this.receiver.id ||
              !sameAsset(outgoing.debitAmount, payment.quote.debitAmount) ||
              minorValue(outgoing.debitAmount.value) !== minorValue(payment.quote.debitAmount.value) ||
              !sameAsset(incoming.receivedAmount, payment.quote.receiveAmount)) {
              throw new Error("Provider payment references or amounts do not match this proof attempt.");
            }
            payment.evidence.sentAmount = outgoing.sentAmount;
            payment.evidence.receivedAmount = incoming.receivedAmount;
            if (outgoing.failed) {
              // a failed payment can still have partial amounts
              payment.evidence.state = "FAILED";
              await this.run.save();
              throw new ProofStepError(payment.evidence.label, new Error("The provider marked the outgoing payment failed. See the report for any partial amounts."));
            }
            // confirmed success needs an explicitly not-failed payment whose sent amount
            // matches the quoted payer debit asset/scale; anything else stays unresolved
            if (outgoing.sentAmount && outgoing.failed === false &&
              minorValue(outgoing.sentAmount.value) === minorValue(outgoing.debitAmount.value) &&
              sameAsset(outgoing.sentAmount, payment.quote.debitAmount) && incoming.completed &&
              minorValue(incoming.receivedAmount.value) >= minorValue(payment.quote.receiveAmount.value)) {
              payment.evidence.state = "SUCCEEDED";
              await this.run.save();
              console.log(JSON.stringify({ event: "payment-confirmed", ...payment.evidence }));
              return payment.evidence;
            }
            await this.run.save();
          } catch (error) {
            if (error instanceof ProofStepError) throw error;
            // retry the read, never the debit
            this.run.report.results.lastReconciliationError = this.run.safeError(error);
          }
          await delay(1000);
        }
        throw new Error("Provider outcome is still pending or unknown. Reconcile the recorded IDs before another debit.");
      });
    } catch (error) {
      if (payment.evidence.state !== "FAILED") payment.evidence.state = "UNKNOWN";
      await this.run.save();
      throw error;
    }
  }

  // provider-reported grant usage, not the account balance
  async spent(spending: ApprovedSpending): Promise<Amount | null> {
    this.requireLiveGrant(spending);
    const amounts = await this.run.step("read provider grant spent amounts", () => this.client.outgoingPayment.getGrantSpentAmounts({
      url: this.sender.resourceServer,
      accessToken: spending.grant.access_token.value,
    }));
    if (amounts.spentDebitAmount && !sameAsset(amounts.spentDebitAmount, spending.budget)) {
      throw new Error("Provider spent amounts use an unexpected asset or scale.");
    }
    return amounts.spentDebitAmount;
  }

  // try more than the remaining allowance, but no more than the original cap
  async probeBudget(spending: ApprovedSpending, alreadySpent: Amount, firstPaymentDebit: Amount): Promise<void> {
    const remaining = minorValue(spending.budget.value) - minorValue(alreadySpent.value);
    const candidate = remaining + minorValue(firstPaymentDebit.value);
    const debit = { ...spending.budget, value: (candidate > minorValue(spending.budget.value) ? minorValue(spending.budget.value) : candidate).toString() };
    const payment = await this.prepare("B-budget-probe", debit);
    payment.evidence.expectedRejection = true;
    if (minorValue(payment.quote.debitAmount.value) <= remaining) throw new Error("Could not construct an aggregate over-budget probe.");
    this.run.report.results.budgetProbe = {
      approvedBudget: spending.budget,
      spentBefore: alreadySpent,
      remainingBudget: { ...spending.budget, value: remaining.toString() },
      attemptedDebit: payment.quote.debitAmount,
    };
    await this.run.save();
    this.requireLiveGrant(spending);
    try {
      // this Test Wallet request is supposed to be rejected
      await this.submitAndConfirm(payment, spending);
    } catch (error) {
      const original = underlying(error);
      // Rafiki also uses 403/unauthorized here; still check the token and counter
      const budgetDenial = original instanceof OpenPaymentsClientError && original.status === 403 && (
        original.code === "insufficient_grant" ||
        (original.code === "403" && original.description?.trim().toLowerCase() === "unauthorized")
      );
      if (!payment.evidence.outgoingPaymentId && definitiveRejection(error) && budgetDenial) {
        payment.evidence.state = "REJECTED";
        const after = await this.spent(spending);
        if (!after || minorValue(after.value) !== minorValue(alreadySpent.value)) {
          throw new Error("Provider-reported spending changed after the rejected budget probe.");
        }
        this.run.report.results.budgetEnforcement = {
          status: "PASSED",
          rejection: this.run.safeError(error),
          spentBefore: alreadySpent,
          spentAfter: after,
          tokenStillValidAfterRejection: true,
        };
        try {
          await this.run.step("close rejected probe incoming payment", () => this.client.incomingPayment.complete({
            url: payment.incoming.id,
            accessToken: this.incomingGrant.access_token.value,
          }));
        } catch (cleanupError) {
          const safe = this.run.safeError(cleanupError);
          this.run.report.results.unusedIncomingCleanupWarning = safe;
          console.error(JSON.stringify({ event: "incoming-cleanup-warning", ...safe }));
        }
        await this.run.save();
        return;
      }
      this.run.report.results.budgetEnforcement = {
        status: payment.evidence.outgoingPaymentId ? "FAILED_UNEXPECTED_ACCEPTANCE" : "INCONCLUSIVE",
        error: this.run.safeError(error),
      };
      throw error;
    }
    this.run.report.results.budgetEnforcement = { status: "FAILED", reason: "The provider unexpectedly accepted the over-budget request." };
    throw new Error("Provider budget enforcement failed. Stop before enabling offline redemption.");
  }

  async cleanup(): Promise<void> {
    const unresolved = this.run.report.payments.some((payment) => ["SUBMITTING", "PROCESSING", "UNKNOWN"].includes(payment.state));
    const warnings: Record<string, unknown>[] = [];
    for (const handle of this.grants.reverse()) {
      // retain the outgoing spend authority AND the incoming read authority needed to
      // reconcile unresolved payments; quote grants alone can be cancelled safely
      if (unresolved && (handle.purpose === "outgoing" || handle.purpose === "incoming")) continue;
      try {
        await this.client.grant.cancel({ url: testWalletUrl(handle.continuation.uri), accessToken: handle.continuation.access_token.value });
      } catch (error) {
        const safe = this.run.safeError(new ProofStepError("cancel temporary proof grant", error));
        warnings.push(safe);
        console.error(JSON.stringify({ event: "grant-cleanup-warning", ...safe }));
      }
    }
    this.run.report.results.grantCleanup = {
      authoritiesRetainedForUnresolvedPayments: unresolved ? ["outgoing", "incoming"] : [],
      warnings,
    };
    await this.run.save();
  }
}
