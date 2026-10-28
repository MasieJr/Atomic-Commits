import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  type AuthenticatedClient,
  type GrantRequest,
  type GrantWithAccessToken,
} from "@interledger/open-payments";

export interface GrantInteractionOptions {
  port: number;
  timeoutMs: number;
  signal: AbortSignal;
  rememberSecret(value: string): void;
  onRedirect(url: string): Promise<void>;
  onCleanupWarning(error: unknown): void;
}

// keep these dev proofs on Test Wallet
export function testWalletUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".interledger-test.dev") ||
    url.username || url.password || url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Payment proofs only support HTTPS Interledger Test Wallet endpoints.");
  }
  return url.toString();
}

// check the redirect using both nonces, the interaction ref and the original grant URL
export function verifyInteractionHash(
  clientNonce: string,
  providerNonce: string,
  interactRef: string,
  grantUrl: string,
  receivedHash: string,
): boolean {
  // Rafiki uses padded Base64; accept both formats but compare the actual digest
  let received: Buffer;
  if (/^[A-Za-z0-9_-]{43}=?$/.test(receivedHash)) {
    received = Buffer.from(receivedHash, "base64url");
    if (received.toString("base64url") !== receivedHash.replace(/=$/, "")) return false;
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(receivedHash)) {
    received = Buffer.from(receivedHash, "base64");
    if (received.toString("base64") !== (receivedHash.endsWith("=") ? receivedHash : receivedHash + "=")) return false;
  } else {
    return false;
  }
  // GNAP joins these with newlines and no trailing newline
  const expected = createHash("sha256")
    .update([clientNonce, providerNonce, interactRef, grantUrl].join("\n"), "ascii")
    .digest();
  return received.length === expected.length && timingSafeEqual(expected, received);
}

// ask the provider for approval, then wait for one verified callback
// tokens stay in memory and get registered for redaction
export async function requestInteractiveGrant(
  client: AuthenticatedClient,
  authorizationUrl: string,
  access: NonNullable<GrantRequest["access_token"]>,
  options: GrantInteractionOptions,
): Promise<GrantWithAccessToken> {
  options.signal.throwIfAborted();
  const grantUrl = testWalletUrl(authorizationUrl);
  // fresh values tie the redirect to this request
  const clientNonce = randomBytes(32).toString("base64url");
  const callbackPath = `/callback/${randomBytes(32).toString("base64url")}`;
  options.rememberSecret(clientNonce);
  let providerNonce: string | undefined;
  let consumed = false;
  let resolveCallback: ((value: string) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let cleanupContinuation: GrantWithAccessToken["continue"] | undefined;
  let delivered = false;
  const onAbort = () => rejectCallback?.(new Error("The proof was interrupted while waiting for consent."));

  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Connection", "close");
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400).end("Invalid callback URL.");
      return;
    }
    if (request.method !== "GET" || url.pathname !== callbackPath || !providerNonce) {
      response.writeHead(404).end("Not found.");
      return;
    }
    if (consumed) {
      response.writeHead(409).end("This approval callback has already been consumed.");
      return;
    }
    // Rafiki sends a result/error when the interaction is rejected or invalid
    if (url.searchParams.has("error") || url.searchParams.has("result")) {
      consumed = true;
      response.writeHead(400).end("Provider approval was denied or cancelled.");
      rejectCallback?.(new Error("Provider approval was denied or cancelled."));
      return;
    }
    // don't continue the grant until this hash checks out
    const interactRef = url.searchParams.get("interact_ref");
    const hash = url.searchParams.get("hash");
    if (
      !interactRef || !hash ||
      url.searchParams.getAll("interact_ref").length !== 1 ||
      url.searchParams.getAll("hash").length !== 1 ||
      !verifyInteractionHash(clientNonce, providerNonce, interactRef, grantUrl, hash)
    ) {
      console.error(JSON.stringify({ event: "callback-rejected", hasInteractionRef: Boolean(interactRef), receivedHashLength: hash?.length ?? 0 }));
      response.writeHead(400).end("The provider callback could not be verified.");
      return;
    }
    consumed = true;
    response.writeHead(200).end("Provider approval verified. You can return to the terminal.", () => {
      resolveCallback?.(interactRef);
    });
  });

  try {
    // this callback listener is local to the dev machine
    server.listen(options.port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the consent callback.");
    const callbackUrl = `http://localhost:${address.port}${callbackPath}`;
    const pending = await client.grant.request({ url: grantUrl }, {
      access_token: access,
      interact: {
        start: ["redirect"],
        finish: { method: "redirect", uri: callbackUrl, nonce: clientNonce },
      },
    });
    cleanupContinuation = pending.continue;
    options.rememberSecret(pending.continue.access_token.value);
    // this proof expects a fresh provider approval screen
    if (!isPendingGrant(pending)) {
      if (isFinalizedGrantWithAccessToken(pending)) {
        options.rememberSecret(pending.access_token.value);
      }
      throw new Error("The provider did not request an interactive approval; this proof requires explicit consent.");
    }
    providerNonce = pending.interact.finish;
    if (!providerNonce) throw new Error("The provider did not supply an interaction-finish nonce.");
    options.rememberSecret(providerNonce);
    options.signal.throwIfAborted();
    const deadline = Date.now() + options.timeoutMs;
    const receivedAt = Date.now();
    // the HTTP handler resolves this; timeout or Ctrl+C rejects it
    const callback = new Promise<string>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
      timeout = setTimeout(() => reject(new Error("Timed out waiting for provider approval.")), options.timeoutMs);
    });
    // handle early rejection; the await below still reports it
    void callback.catch(() => {});
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    await options.onRedirect(testWalletUrl(pending.interact.redirect));
    const interactRef = await callback;
    if (timeout) clearTimeout(timeout);

    let continuation = pending.continue;
    let continuationReceivedAt = receivedAt;
    let first = true;
    while (Date.now() < deadline) {
      options.signal.throwIfAborted();
      // the provider tells us how long to wait before continuing again
      const waitMs = Math.max(0, continuationReceivedAt + (continuation.wait ?? 0) * 1000 - Date.now());
      if (Date.now() + waitMs >= deadline) break;
      if (waitMs) await delay(waitMs);
      options.signal.throwIfAborted();
      options.rememberSecret(continuation.access_token.value);
      // only the first continuation carries the interaction ref
      const result = await client.grant.continue({
        url: testWalletUrl(continuation.uri),
        accessToken: continuation.access_token.value,
      }, first ? { interact_ref: interactRef } : undefined);
      first = false;
      cleanupContinuation = result.continue;
      options.rememberSecret(result.continue.access_token.value);
      if (isFinalizedGrantWithAccessToken(result)) {
        options.rememberSecret(result.access_token.value);
        // the caller now owns this grant and its cleanup
        delivered = true;
        return result;
      }
      continuation = result.continue;
      continuationReceivedAt = Date.now();
      if (!continuation.wait) await delay(1000);
    }
    throw new Error("The provider did not finalize the grant before the approval deadline.");
  } finally {
    // close the listener and cancel any grant we couldn't finish
    options.signal.removeEventListener("abort", onAbort);
    if (timeout) clearTimeout(timeout);
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    if (!delivered && cleanupContinuation) {
      try {
        await client.grant.cancel({
          url: testWalletUrl(cleanupContinuation.uri),
          accessToken: cleanupContinuation.access_token.value,
        });
      } catch (error) {
        options.onCleanupWarning(error);
      }
    }
  }
}
