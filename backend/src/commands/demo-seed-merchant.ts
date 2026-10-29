import "dotenv/config";

import { createDatabasePool } from "../db/pool";
import { lookupWalletAddresses } from "../services/open-payments";

/*
 * DEMO provisioning: turns an existing registered account into a merchant with
 * a verified receiving Test Wallet. The merchant then logs in normally; only
 * accounts with a merchant row can redeem codes.
 *
 * Usage: npm run demo:seed-merchant -- merchant@example.com "$ilp.interledger-test.dev/your-shop" "Shop name"
 *        add --skip-wallet-check to skip the live wallet lookup (offline testing only)
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--skip-wallet-check");
  const skipCheck = process.argv.includes("--skip-wallet-check");
  const [email, walletAddress, displayName = "Demo merchant"] = args;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !email || !walletAddress) {
    throw new Error('Usage: npm run demo:seed-merchant -- <user-email> <wallet-address> ["Shop name"]');
  }

  /* store the canonical wallet id the provider reports, not whatever was typed */
  let walletId = walletAddress.trim();
  if (!skipCheck) {
    const [wallet] = await lookupWalletAddresses([walletAddress]);
    walletId = wallet.id;
    console.log(`Wallet verified: ${wallet.id} (${wallet.assetCode}, scale ${wallet.assetScale})`);
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    const user = await pool.query("SELECT id FROM app_private.users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!user.rows[0]) throw new Error("No user with that email. Register the merchant account first.");
    const merchant = await pool.query(
      `INSERT INTO app_private.merchants (user_id, display_name, receiving_wallet_address)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, receiving_wallet_address = EXCLUDED.receiving_wallet_address
       RETURNING id`,
      [user.rows[0].id, displayName, walletId],
    );
    console.log(`Merchant ready. merchantId: ${merchant.rows[0].id}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seeding failed.");
  process.exitCode = 1;
});
