import "dotenv/config";

import { OpenPaymentsClientError } from "@interledger/open-payments";

import { lookupWalletAddresses } from "../services/open-payments";

// Temporary backend-only inspection command for the first two-wallet integration.
async function main(): Promise<void> {
  const addresses = process.argv.slice(2);
  if (addresses.length === 0) {
    const sender = process.env.SENDING_WALLET_ADDRESS_URL?.trim();
    const receiver = process.env.RECEIVING_WALLET_ADDRESS_URL?.trim();
    if (!sender || !receiver) {
      throw new Error(
        "Set the temporary SENDING_WALLET_ADDRESS_URL and RECEIVING_WALLET_ADDRESS_URL in backend/.env, or pass one or two wallet address URLs/payment pointers.",
      );
    }
    addresses.push(sender, receiver);
  }
  if (addresses.length > 2) {
    throw new Error("Pass at most two wallet address URLs.");
  }

  const walletAddresses = await lookupWalletAddresses(addresses);
  console.log(JSON.stringify({ mode: "temporary-integration-lookup", walletAddresses }, null, 2));
}

void main().catch((error: unknown) => {
  if (error instanceof OpenPaymentsClientError) {
    console.error("Wallet address lookup failed.", {
      status: error.status,
      code: error.code,
      message: error.message,
    });
  } else {
    console.error(error instanceof Error ? error.message : "Wallet address lookup failed.");
  }
  process.exitCode = 1;
});
