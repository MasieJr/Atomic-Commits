import {
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  OpenPaymentsClientError,
  type AuthenticatedClient,
  type WalletAddress,
} from "@interledger/open-payments";
import { setTimeout as delay } from "node:timers/promises";

import { testWalletUrl } from "./grant-interaction";
import { createOpenPaymentsClient, lookupWalletAddresses } from "./open-payments";
import { validateReturnedOutgoingGrant } from "./outgoing-grant-validation";
import {
  parseMinor,
  ProviderRejectedError,
  ProviderUnknownError,
  sameAsset,
  type Money,
  type ProviderErrorDetail,
  type OutgoingAuthority,
  type PreparedQuote,
  type ProviderOutcome,
  type RedemptionProvider,
  type WalletInfo,
} from "./redemption-provider";

/*
 * Live Interledger Test Wallet adapter. The calls mirror the ones already
 * proven live in payment-proof.ts (incoming payment, quote, outgoing payment,
 * reads, token rotation). Test Wallet endpoints only.
 *
 * The incoming-payment and quote grants are non-interactive resource grants:
 * they never grant spending. Only the payer-approved outgoing token (passed in
 * per call, stored encrypted elsewhere) can debit the payer.
 */

interface CachedToken {
  value: string;
  expiresAt: number;
}

const RESOURCE_TOKEN_MARGIN_MS = 15_000;

/* a 4xx that is not a timeout or a validation failure is a definite "no" */
function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof OpenPaymentsClientError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    !error.validationErrors?.length
  );
}

/* bare status and a fixed kind only: the provider's message and description stay out */
function unclearDetail(error: unknown): ProviderErrorDetail {
  if (error instanceof OpenPaymentsClientError) {
    const httpStatus = error.status;
    if (httpStatus === undefined) return { errorKind: error.validationErrors?.length ? "RESPONSE_VALIDATION" : "NETWORK" };
    if (httpStatus >= 500) return { errorKind: "HTTP_5XX", httpStatus };
    if (httpStatus === 408) return { errorKind: "HTTP_408", httpStatus };
    if (httpStatus >= 400 && error.validationErrors?.length) return { errorKind: "HTTP_4XX_VALIDATION", httpStatus };
    if (error.validationErrors?.length) return { errorKind: "RESPONSE_VALIDATION", httpStatus };
    return { errorKind: "OTHER", httpStatus };
  }
  /* undici reports connection failures as TypeError("fetch failed") */
  if (error instanceof TypeError) return { errorKind: "NETWORK" };
  return { errorKind: "OTHER" };
}

function money(amount: { value: string; assetCode: string; assetScale: number }): Money {
  return { value: amount.value, assetCode: amount.assetCode, assetScale: amount.assetScale };
}

const TRANSIENT_RETRY_DELAY_MS = 1_000;
const GRANT_FINISH_DEADLINE_MS = 20_000;

/*
 * One retry for calls with NO money effect (incoming payment, quote, resource
 * grants): a network drop costs nothing to retry. Never used for submitting
 * an outgoing payment.
 */
async function retryOnce<T>(work: () => Promise<T>, retryDelayMs: number): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDefinitiveRejection(error)) throw error;
    await delay(retryDelayMs);
    return work();
  }
}

export interface OpenPaymentsProviderOptions {
  /* injectable for tests; default looks wallets up on the network */
  lookupWallets?: (addresses: string[]) => Promise<WalletAddress[]>;
  retryDelayMs?: number;
}

export function createOpenPaymentsRedemptionProvider(
  createClient: () => Promise<AuthenticatedClient> = createOpenPaymentsClient,
  providerOptions: OpenPaymentsProviderOptions = {},
): RedemptionProvider {
  const lookupWallets = providerOptions.lookupWallets ?? lookupWalletAddresses;
  const retryDelayMs = providerOptions.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
  /* created on first use, so the API can start before Open Payments is configured */
  let clientPromise: Promise<AuthenticatedClient> | undefined;
  const sdk = () => (clientPromise ??= createClient().catch((error) => {
    clientPromise = undefined;
    throw error;
  }));
  const wallets = new Map<string, WalletAddress>();
  const resourceTokens = new Map<string, CachedToken>();

  async function wallet(address: string): Promise<WalletAddress> {
    const cached = wallets.get(address);
    if (cached) return cached;
    const [found] = await retryOnce(() => lookupWallets([address]), retryDelayMs);
    testWalletUrl(found.id);
    testWalletUrl(found.authServer);
    testWalletUrl(found.resourceServer);
    wallets.set(address, found);
    return found;
  }

  /* non-interactive incoming/quote grant, cached until shortly before expiry */
  async function resourceToken(authServer: string, type: "incoming-payment" | "quote"): Promise<string> {
    const cacheKey = `${type}:${authServer}`;
    const cached = resourceTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + RESOURCE_TOKEN_MARGIN_MS) return cached.value;
    const requestedAt = Date.now();
    const grant = await retryOnce(async () => (await sdk()).grant.request(
      { url: authServer },
      {
        access_token: {
          access:
            type === "incoming-payment"
              ? [{ type: "incoming-payment", actions: ["create", "read", "complete"] }]
              : [{ type: "quote", actions: ["create", "read"] }],
        },
      },
    ), retryDelayMs);
    if (!isFinalizedGrantWithAccessToken(grant)) {
      throw new Error("The resource grant unexpectedly requires interaction.");
    }
    const seconds = grant.access_token.expires_in;
    resourceTokens.set(cacheKey, {
      value: grant.access_token.value,
      /* unknown expiry: don't reuse it */
      expiresAt: typeof seconds === "number" && seconds > 0 ? requestedAt + seconds * 1000 : 0,
    });
    return grant.access_token.value;
  }

  async function closeIncoming(incomingPaymentId: string, merchant: WalletAddress): Promise<void> {
    await (await sdk()).incomingPayment.complete({
      url: testWalletUrl(incomingPaymentId),
      accessToken: await resourceToken(merchant.authServer, "incoming-payment"),
    });
  }

  function walletInfo(found: WalletAddress): WalletInfo {
    return { id: found.id, assetCode: found.assetCode, assetScale: found.assetScale, authServer: found.authServer };
  }

  return {
    async lookupWallet(address) {
      return walletInfo(await wallet(address));
    },

    async completeIncoming({ incomingPaymentId, merchantWalletAddress }) {
      await closeIncoming(incomingPaymentId, await wallet(merchantWalletAddress));
    },

    async startOutgoingGrant({ wallet: payer, debitLimit, finishUri, clientNonce }) {
      const grantRequestUrl = testWalletUrl(payer.authServer);
      const pending = await retryOnce(async () => (await sdk()).grant.request({ url: grantRequestUrl }, {
        access_token: {
          access: [{
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: payer.id,
            limits: { debitAmount: debitLimit },
          }],
        },
        interact: { start: ["redirect"], finish: { method: "redirect", uri: finishUri, nonce: clientNonce } },
      }), retryDelayMs);
      if (!isPendingGrant(pending) || !pending.interact.finish) {
        /* consent must be explicit: a grant that skips interaction is refused */
        await (await sdk()).grant.cancel({
          url: testWalletUrl(pending.continue.uri),
          accessToken: pending.continue.access_token.value,
        }).catch(() => {});
        throw new Error("The provider did not ask the payer for explicit approval.");
      }
      return {
        redirectUrl: testWalletUrl(pending.interact.redirect),
        providerNonce: pending.interact.finish,
        grantRequestUrl,
        continuation: { uri: testWalletUrl(pending.continue.uri), accessToken: pending.continue.access_token.value },
      };
    },

    async finishOutgoingGrant({ continuation, interactRef, wallet: payer, requestedDebit }) {
      const client = await sdk();
      const deadline = Date.now() + GRANT_FINISH_DEADLINE_MS;
      let current = continuation;
      let first = true;
      while (Date.now() < deadline) {
        const requestedAt = Date.now();
        /* only the first continuation carries the interaction ref */
        const result = await client.grant.continue(
          { url: testWalletUrl(current.uri), accessToken: current.accessToken },
          first ? { interact_ref: interactRef } : undefined,
        );
        first = false;
        if (isFinalizedGrantWithAccessToken(result)) {
          /* trust what the provider granted, not what we asked for */
          const returned = validateReturnedOutgoingGrant(result, { payerId: payer.id, requestedDebit });
          return {
            authority: {
              accessToken: result.access_token.value,
              manageUrl: result.access_token.manage,
              expiresAtEpochMs: requestedAt + returned.expiresInSeconds * 1000,
            },
            continuation: { uri: testWalletUrl(result.continue.uri), accessToken: result.continue.access_token.value },
            grantedDebit: money(returned.budget),
          };
        }
        current = { uri: result.continue.uri, accessToken: result.continue.access_token.value };
        await delay(Math.max(1, result.continue.wait ?? 1) * 1000);
      }
      throw new ProviderUnknownError("The provider did not finalize the grant in time.");
    },

    async prepareQuote({ payerWalletAddress, merchantWalletAddress, merchantReceive, reference }): Promise<PreparedQuote> {
      const [payer, merchant] = await Promise.all([wallet(payerWalletAddress), wallet(merchantWalletAddress)]);
      if (payer.id === merchant.id) throw new Error("Payer and merchant wallets must differ.");
      if (!sameAsset(merchantReceive, merchant)) throw new Error("merchantReceive must use the merchant wallet's asset.");

      const incoming = await retryOnce(async () => (await sdk()).incomingPayment.create(
        { url: merchant.resourceServer, accessToken: await resourceToken(merchant.authServer, "incoming-payment") },
        {
          walletAddress: merchant.id,
          incomingAmount: merchantReceive,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          metadata: { description: "Atomic Commits offline payment", reference },
        },
      ), retryDelayMs);
      testWalletUrl(incoming.id);
      if (incoming.walletAddress !== merchant.id) throw new Error("Incoming payment created for the wrong wallet.");

      let quote;
      try {
        quote = await retryOnce(async () => (await sdk()).quote.create(
          { url: payer.resourceServer, accessToken: await resourceToken(payer.authServer, "quote") },
          { walletAddress: payer.id, receiver: incoming.id, method: "ilp" },
        ), retryDelayMs);
      } catch (error) {
        /* no quote = nothing will be paid: close the merchant's request so it doesn't linger */
        await closeIncoming(incoming.id, merchant).catch(() => {});
        throw error;
      }
      testWalletUrl(quote.id);
      if (
        quote.walletAddress !== payer.id ||
        quote.receiver !== incoming.id ||
        !sameAsset(money(quote.debitAmount), payer) ||
        !sameAsset(money(quote.receiveAmount), merchant) ||
        parseMinor(quote.receiveAmount.value) !== parseMinor(merchantReceive.value)
      ) {
        throw new Error("The quote does not match the intended payer, merchant or amount.");
      }
      return {
        incomingPaymentId: incoming.id,
        quoteId: quote.id,
        debit: money(quote.debitAmount),
        receive: money(quote.receiveAmount),
        ...(quote.expiresAt ? { expiresAtEpochMs: Date.parse(quote.expiresAt) } : {}),
      };
    },

    async submitPayment({ payerWalletAddress, quoteId, authority }) {
      const payer = await wallet(payerWalletAddress).catch(() => {
        /* nothing has been sent yet, so this is a definite failure */
        throw new ProviderRejectedError("Payer wallet lookup failed before submission.");
      });
      try {
        /* ONE call, no retry: an unclear answer is UNKNOWN, never "try again" */
        const outgoing = await (await sdk()).outgoingPayment.create(
          { url: payer.resourceServer, accessToken: authority.accessToken },
          { walletAddress: payer.id, quoteId },
        );
        testWalletUrl(outgoing.id);
        return { outgoingPaymentId: outgoing.id };
      } catch (error) {
        if (isDefinitiveRejection(error)) throw new ProviderRejectedError("The provider refused the payment.");
        throw new ProviderUnknownError("The payment outcome is unknown.");
      }
    },

    async readOutcome({ outgoingPaymentId, incomingPaymentId, merchantWalletAddress, expectedDebit, authority }): Promise<ProviderOutcome> {
      const merchant = await wallet(merchantWalletAddress);
      const client = await sdk();
      const [outgoing, incoming] = await Promise.all([
        client.outgoingPayment.get({ url: testWalletUrl(outgoingPaymentId), accessToken: authority.accessToken }),
        client.incomingPayment.get({
          url: testWalletUrl(incomingPaymentId),
          accessToken: await resourceToken(merchant.authServer, "incoming-payment"),
        }),
      ]);
      if (
        outgoing.receiver !== incomingPaymentId ||
        incoming.walletAddress !== merchant.id ||
        !sameAsset(money(outgoing.debitAmount), expectedDebit) ||
        parseMinor(outgoing.debitAmount.value) !== parseMinor(expectedDebit.value)
      ) {
        return { kind: "PENDING" }; /* don't trust a mismatching answer either way */
      }
      if (outgoing.failed) return { kind: "FAILED" };
      if (
        outgoing.failed === false &&
        outgoing.sentAmount &&
        parseMinor(outgoing.sentAmount.value) === parseMinor(outgoing.debitAmount.value) &&
        incoming.completed
      ) {
        return { kind: "SUCCEEDED", sent: money(outgoing.sentAmount), received: money(incoming.receivedAmount) };
      }
      return { kind: "PENDING" };
    },

    async findOutgoingByQuote({ payerWalletAddress, quoteId, authority }) {
      const payer = await wallet(payerWalletAddress);
      const client = await sdk();
      let cursor: string | undefined;
      /* bounded scan of the payer's most recent outgoing payments */
      for (let page = 0; page < 5; page += 1) {
        const result = await client.outgoingPayment.list(
          { url: payer.resourceServer, walletAddress: payer.id, accessToken: authority.accessToken },
          { first: 50, "wallet-address": payer.id, ...(cursor ? { cursor } : {}) },
        );
        const match = result.result.find((payment) => payment.quoteId === quoteId);
        if (match) return { outgoingPaymentId: testWalletUrl(match.id) };
        if (!result.pagination.hasNextPage || !result.pagination.endCursor) return undefined;
        cursor = result.pagination.endCursor;
      }
      throw new ProviderUnknownError("Too many payments to scan safely.");
    },

    async cancelGrant(continuation) {
      let url: string;
      try {
        url = testWalletUrl(continuation.uri);
      } catch {
        throw new ProviderUnknownError("The cancellation outcome is unknown.", { errorKind: "URL_NOT_ALLOWED" });
      }
      try {
        await (await sdk()).grant.cancel({ url, accessToken: continuation.accessToken });
      } catch (error) {
        if (isDefinitiveRejection(error)) {
          throw new ProviderRejectedError("The provider refused the cancellation.", (error as OpenPaymentsClientError).status);
        }
        throw new ProviderUnknownError("The cancellation outcome is unknown.", unclearDetail(error));
      }
    },

    async rotateAuthority(authority: OutgoingAuthority): Promise<OutgoingAuthority> {
      if (!authority.manageUrl) throw new ProviderRejectedError("No manage URL: the payer must re-authorize.");
      const requestedAt = Date.now();
      try {
        const rotated = await (await sdk()).token.rotate({ url: testWalletUrl(authority.manageUrl), accessToken: authority.accessToken });
        const seconds = rotated.access_token.expires_in;
        return {
          accessToken: rotated.access_token.value,
          manageUrl: rotated.access_token.manage,
          ...(typeof seconds === "number" && seconds > 0 ? { expiresAtEpochMs: requestedAt + seconds * 1000 } : {}),
        };
      } catch (error) {
        if (isDefinitiveRejection(error)) throw new ProviderRejectedError("Token rotation was refused.");
        throw new ProviderUnknownError("Token rotation outcome is unknown.");
      }
    },
  };
}
