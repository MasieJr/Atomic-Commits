import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuthenticatedClient } from "@interledger/open-payments";
import { createWalletVerificationProvider } from "../src/services/wallet-verification-provider";

const wallet = {
  id: "https://ilp.interledger-test.dev/alice",
  authServer: "https://auth.interledger-test.dev/",
  assetCode: "USD",
  assetScale: 2,
};

function fixture(subject = wallet.id) {
  let requested: unknown;
  let continued: unknown;
  let cancelled = 0;
  const continuation = {
    uri: "https://auth.interledger-test.dev/continue/1",
    access_token: { value: "secret-continuation" },
  };
  const sdk = {
    grant: {
      request: async (_options: unknown, body: unknown) => {
        requested = body;
        return { interact: { redirect: "https://auth.interledger-test.dev/approve", finish: "provider-nonce" }, continue: continuation };
      },
      continue: async (_options: unknown, body: unknown) => {
        continued = body;
        return { subject: { sub_ids: [{ format: "uri", id: subject }] }, continue: continuation };
      },
      cancel: async () => { cancelled += 1; },
    },
  } as unknown as AuthenticatedClient;
  return {
    provider: createWalletVerificationProvider(async () => sdk),
    get requested() { return requested; },
    get continued() { return continued; },
    get cancelled() { return cancelled; },
  };
}

test("ownership verification requests only a subject and completes the same wallet after consent", async () => {
  const f = fixture();
  const started = await f.provider.start(wallet, "https://api.example.test/callback", "client-nonce");
  assert.deepEqual(f.requested, {
    subject: { sub_ids: [{ id: wallet.id, format: "uri" }] },
    interact: { start: ["redirect"], finish: { method: "redirect", uri: "https://api.example.test/callback", nonce: "client-nonce" } },
  });
  assert.equal(started.redirectUrl, "https://auth.interledger-test.dev/approve");
  await f.provider.finish(started, wallet.id, "provider-ref");
  assert.deepEqual(f.continued, { interact_ref: "provider-ref" });
  assert.equal(f.cancelled, 1);
});

test("ownership verification refuses a finalized subject for another wallet", async () => {
  const f = fixture("https://ilp.interledger-test.dev/bob");
  const started = await f.provider.start(wallet, "https://api.example.test/callback", "client-nonce");
  await assert.rejects(f.provider.finish(started, wallet.id, "provider-ref"), /different wallet subject/);
});
