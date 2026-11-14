import { setTimeout as delay } from "node:timers/promises";

import {
  isFinalizedGrantWithAccessToken,
  isFinalizedGrantWithSubject,
  isPendingGrant,
  type AuthenticatedClient,
} from "@interledger/open-payments";

import { testWalletUrl } from "./grant-interaction";
import { createOpenPaymentsClient } from "./open-payments";
import type { GrantContinuation, WalletInfo } from "./redemption-provider";

export interface StartedWalletVerification {
  readonly redirectUrl: string;
  readonly providerNonce: string;
  readonly grantRequestUrl: string;
  readonly continuation: GrantContinuation;
  readonly continueAfterMs: number;
}

export interface WalletVerificationProvider {
  start(wallet: WalletInfo, finishUri: string, clientNonce: string): Promise<StartedWalletVerification>;
  finish(started: StartedWalletVerification, walletAddress: string, interactRef: string): Promise<void>;
  cancel(continuation: GrantContinuation): Promise<void>;
}

export function createWalletVerificationProvider(
  createClient: () => Promise<AuthenticatedClient> = createOpenPaymentsClient,
): WalletVerificationProvider {
  let clientPromise: Promise<AuthenticatedClient> | undefined;
  const sdk = () => (clientPromise ??= createClient().catch((error) => {
    clientPromise = undefined;
    throw error;
  }));

  return {
    async start(wallet, finishUri, clientNonce) {
      const grantRequestUrl = testWalletUrl(wallet.authServer);
      const result = await (await sdk()).grant.request({ url: grantRequestUrl }, {
        subject: { sub_ids: [{ id: wallet.id, format: "uri" }] },
        interact: { start: ["redirect"], finish: { method: "redirect", uri: finishUri, nonce: clientNonce } },
      });
      if (!isPendingGrant(result) || !result.interact.finish) {
        await (await sdk()).grant.cancel({
          url: testWalletUrl(result.continue.uri), accessToken: result.continue.access_token.value,
        }).catch(() => {});
        throw new Error("The wallet provider did not request interactive verification.");
      }
      return {
        redirectUrl: testWalletUrl(result.interact.redirect),
        providerNonce: result.interact.finish,
        grantRequestUrl,
        continuation: { uri: testWalletUrl(result.continue.uri), accessToken: result.continue.access_token.value },
        continueAfterMs: Date.now() + Math.max(0, result.continue.wait ?? 0) * 1000,
      };
    },

    async finish(started, walletAddress, interactRef) {
      const initialWait = Math.max(0, started.continueAfterMs - Date.now());
      const deadline = Date.now() + Math.min(90_000, initialWait + 20_000);
      let continuation = started.continuation;
      let waitUntil = started.continueAfterMs;
      let first = true;
      while (Date.now() < deadline) {
        const waitMs = Math.max(0, waitUntil - Date.now());
        if (Date.now() + waitMs >= deadline) break;
        if (waitMs) await delay(waitMs);
        const result = await (await sdk()).grant.continue(
          { url: testWalletUrl(continuation.uri), accessToken: continuation.accessToken },
          first ? { interact_ref: interactRef } : undefined,
        );
        first = false;
        if (isFinalizedGrantWithSubject(result)) {
          if (!result.subject.sub_ids.some((subject) => subject.format === "uri" && subject.id === walletAddress)) {
            throw new Error("The provider returned a different wallet subject.");
          }
          await this.cancel({ uri: result.continue.uri, accessToken: result.continue.access_token.value }).catch(() => {});
          return;
        }
        // The Open Payments ownership guide also describes a finalized access-token response.
        if (isFinalizedGrantWithAccessToken(result)) {
          await this.cancel({ uri: result.continue.uri, accessToken: result.continue.access_token.value }).catch(() => {});
          return;
        }
        continuation = { uri: testWalletUrl(result.continue.uri), accessToken: result.continue.access_token.value };
        waitUntil = Date.now() + Math.max(1, result.continue.wait ?? 1) * 1000;
      }
      throw new Error("The provider did not finish wallet verification in time.");
    },

    async cancel(continuation) {
      await (await sdk()).grant.cancel({
        url: testWalletUrl(continuation.uri), accessToken: continuation.accessToken,
      });
    },
  };
}
