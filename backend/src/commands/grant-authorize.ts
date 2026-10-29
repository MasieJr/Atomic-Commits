import "dotenv/config";

import { createHash } from "node:crypto";

import { createDatabasePool } from "../db/pool";
import { createDataEncryptionFromEnv } from "../services/data-encryption";
import { createGrantAuthorityStore } from "../services/grant-authority-store";
import { requestInteractiveGrant, testWalletUrl } from "../services/grant-interaction";
import { createOpenPaymentsClient, lookupWalletAddresses } from "../services/open-payments";
import { validateReturnedOutgoingGrant } from "../services/outgoing-grant-validation";

/*
 * REAL payer consent for the demo (P0 provisioning script, allowed by the
 * handoff in place of wallet-link screens). It asks the Test Wallet for a
 * bounded outgoing-payment grant, prints the approval URL for the payer to open,
 * validates what the provider actually granted, and stores it with the tokens
 * ENCRYPTED. The printed authorizationId is what device enrollment needs.
 *
 * Run it on a machine with a browser (the provider redirects to localhost).
 *
 * Usage: npm run grant:authorize -- payer@example.com "$ilp.interledger-test.dev/payer" [capMinor=50000] [perPaymentMinor=5000] [validHours=24]
 *   50000 = R500.00 total, 5000 = R50.00 per payment (for a ZAR wallet, scale 2)
 */
function positiveInteger(value: string | undefined, fallback: string, name: string): bigint {
  const raw = value ?? fallback;
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) throw new Error(`${name} must be a positive whole number.`);
  return BigInt(raw);
}

async function main(): Promise<void> {
  const [email, walletAddress, capArg, perArg, hoursArg] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !email || !walletAddress) {
    throw new Error("Usage: npm run grant:authorize -- <payer-email> <payer-wallet-address> [capMinor] [perPaymentMinor] [validHours]");
  }
  const cap = positiveInteger(capArg, "50000", "capMinor");
  const perPayment = positiveInteger(perArg, "5000", "perPaymentMinor");
  const validHours = Number(positiveInteger(hoursArg, "24", "validHours"));
  if (perPayment > cap) throw new Error("perPaymentMinor cannot exceed capMinor.");

  const encryption = createDataEncryptionFromEnv();
  const store = createGrantAuthorityStore(encryption);
  const pool = createDatabasePool(databaseUrl);
  try {
    const user = await pool.query("SELECT id FROM app_private.users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!user.rows[0]) throw new Error("No user with that email. Register the payer account first.");

    const [payer] = await lookupWalletAddresses([walletAddress]);
    testWalletUrl(payer.id);
    testWalletUrl(payer.authServer);
    const budget = { value: cap.toString(), assetCode: payer.assetCode, assetScale: payer.assetScale };
    console.log(`Payer wallet: ${payer.id} (${payer.assetCode}, scale ${payer.assetScale})`);
    console.log(`Requesting a grant capped at ${cap} minor units, ${perPayment} per payment (server-enforced).`);

    const client = await createOpenPaymentsClient();
    const controller = new AbortController();
    const grant = await requestInteractiveGrant(
      client,
      payer.authServer,
      { access: [{ type: "outgoing-payment", actions: ["create", "read"], identifier: payer.id, limits: { debitAmount: budget } }] },
      {
        port: Number(process.env.PAYMENT_PROOF_CALLBACK_PORT ?? 3999),
        timeoutMs: 10 * 60 * 1000,
        signal: controller.signal,
        rememberSecret: () => {},
        onCleanupWarning: () => console.error("Warning: an unfinished grant could not be cancelled."),
        onRedirect: async (url) => {
          console.log("\nThe PAYER must open this link and approve:\n");
          console.log(url);
          console.log("\nWaiting for approval (10 minutes max)...");
        },
      },
    );

    /* trust what the provider granted, not what we asked for */
    const returned = validateReturnedOutgoingGrant(grant, { payerId: payer.id, requestedDebit: budget });
    const requestedAt = Date.now();
    const grantedCap = BigInt(returned.budget.value);
    if (perPayment > grantedCap) throw new Error("The provider granted less than one payment's maximum.");

    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      const inserted = await client2.query(
        `INSERT INTO app_private.payment_grants
           (payer_user_id, payer_wallet_address, authority_source, provider_grant_ref, asset_code, asset_scale,
            cumulative_cap, per_payment_max_debit, valid_from, valid_until)
         VALUES ($1, $2, 'PROVIDER', $3, $4, $5, $6, $7, now(), now() + make_interval(hours => $8))
         RETURNING id`,
        [
          user.rows[0].id,
          payer.id,
          /* opaque reference: a digest, never the raw continuation URI */
          createHash("sha256").update(grant.continue.uri).digest("hex").slice(0, 32),
          returned.budget.assetCode,
          returned.budget.assetScale,
          grantedCap.toString(),
          perPayment.toString(),
          validHours,
        ],
      );
      const grantId = inserted.rows[0].id as string;
      await store.saveAuthority(client2, grantId, {
        accessToken: grant.access_token.value,
        manageUrl: grant.access_token.manage,
        expiresAtEpochMs: requestedAt + returned.expiresInSeconds * 1000,
      });
      await store.saveContinuation(client2, grantId, {
        uri: grant.continue.uri,
        accessToken: grant.continue.access_token.value,
      });
      await client2.query("COMMIT");
      console.log(`\nGrant approved and stored (tokens encrypted).`);
      console.log(`authorizationId: ${grantId}`);
      console.log(`Use it for POST /api/devices/totp/enroll.`);
    } catch (error) {
      await client2.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client2.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Grant authorization failed.");
  process.exitCode = 1;
});
