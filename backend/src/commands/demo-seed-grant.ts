import "dotenv/config";

import { createDatabasePool } from "../db/pool";

/*
 * DEMO ONLY. Inserts a PLACEHOLDER grant row so device enrollment can be
 * rehearsed before the real provider consent flow is wired in.
 *
 * It has authority_source = DEMO_PLACEHOLDER and NO provider authority: it can
 * enroll a device but it cannot move money. Redemption must refuse it.
 *
 * Usage: npm run demo:seed-grant -- you@example.com [wallet-address]
 */
async function main(): Promise<void> {
  const [email, walletAddress = "$ilp.interledger-test.dev/demo-payer"] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !email) {
    throw new Error("Usage: DATABASE_URL=... npm run demo:seed-grant -- <user-email> [wallet-address]");
  }

  const pool = createDatabasePool(databaseUrl);
  try {
    const user = await pool.query("SELECT id FROM app_private.users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!user.rows[0]) throw new Error("No user with that email. Register first.");

    const grant = await pool.query(
      `INSERT INTO app_private.payment_grants
         (payer_user_id, payer_wallet_address, authority_source, asset_code, asset_scale,
          cumulative_cap, per_payment_max_debit, valid_from, valid_until)
       VALUES ($1, $2, 'DEMO_PLACEHOLDER', 'ZAR', 2, 50000, 5000, now(), now() + interval '30 days')
       RETURNING id`,
      [user.rows[0].id, walletAddress],
    );
    console.log(`Placeholder grant created (NO provider authority, cannot move money).`);
    console.log(`authorizationId: ${grant.rows[0].id}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seeding failed.");
  process.exitCode = 1;
});
