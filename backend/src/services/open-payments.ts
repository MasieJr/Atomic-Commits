import { resolve } from "node:path";

import {
  createAuthenticatedClient,
  createUnauthenticatedClient,
  type WalletAddress,
} from "@interledger/open-payments";

const clientOptions = {
  requestTimeoutMs: 10_000,
  logLevel: "silent" as const,
  validateResponses: true,
};

// normalise and validate a wallet address
function walletAddressUrl(value: string): string {
  // correct format and we aren't considering whitespace
  const address = value.trim();
  const isPaymentPointer = address.startsWith("$");

  let url: URL;
  try {
    url = new URL(isPaymentPointer ? `https://${address.slice(1)}` : address);
  } catch {
    throw new Error("Use an HTTPS wallet address URL or a $ payment pointer.");
  }

  // reject if its http protocol, malformed or has other data embedded
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      "Wallet addresses must use HTTPS without credentials or a fragment.",
    );
  }
  if (isPaymentPointer && url.pathname === "/") {
    url.pathname = "/.well-known/pay";
  }
  return url.toString();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in backend/.env.`);
  return value;
}

// build a new SDK client with our backend's registered key
// we can reuse it across users - payer wallets and grants go on each payment
export function createOpenPaymentsClient() {
  return createAuthenticatedClient({
    ...clientOptions,
    // our backend's shared provider-side client identity
    walletAddressUrl: walletAddressUrl(
      requiredEnvironment("CLIENT_WALLET_ADDRESS_URL"),
    ),
    keyId: requiredEnvironment("KEY_ID"),
    privateKey: resolve(requiredEnvironment("PRIVATE_KEY_PATH")),
  });
}

export async function lookupWalletAddresses(
  addresses: string[],
): Promise<WalletAddress[]> {
  const urls = addresses.map(walletAddressUrl);
  // wallet metadata is publci so here we dont need a signing key like the prev method
  const client = await createUnauthenticatedClient(clientOptions);
  return Promise.all(urls.map((url) => client.walletAddress.get({ url })));
}
