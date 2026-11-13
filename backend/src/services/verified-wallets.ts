import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { ApiError } from "../errors/api-error";
import type { DataEncryption } from "./data-encryption";
import { verifyInteractionHash } from "./grant-interaction";
import { publicCallbackOrigin } from "./public-origin";
import type { RedemptionProvider } from "./redemption-provider";
import type { StartedWalletVerification, WalletVerificationProvider } from "./wallet-verification-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_TTL_MS = 10 * 60_000;
const context = (id: string) => `wallet-verification:${id}`;

export function createVerifiedWalletService(options: {
  pool: Pool;
  encryption: DataEncryption;
  walletProvider: Pick<RedemptionProvider, "lookupWallet">;
  verificationProvider: WalletVerificationProvider;
  publicBaseUrl?: string;
  now?: () => number;
}) {
  const { pool, encryption, walletProvider, verificationProvider } = options;
  const now = options.now ?? Date.now;

  async function getWallet(userId: number) {
    const { rows } = await pool.query(
      `SELECT wallet_address, asset_code, asset_scale, public_name, verified_at
         FROM app_private.verified_wallets WHERE user_id = $1`, [userId],
    );
    const row = rows[0];
    return row ? {
      address: row.wallet_address,
      assetCode: row.asset_code,
      assetScale: row.asset_scale,
      publicName: row.public_name,
      verifiedAt: new Date(row.verified_at).toISOString(),
    } : null;
  }

  async function start(userId: number, body: unknown) {
    const base = publicCallbackOrigin(options.publicBaseUrl);
    if (await getWallet(userId)) throw new ApiError(409, "A wallet is already linked to this account.", "WALLET_ALREADY_LINKED");
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (typeof input.walletAddress !== "string" || input.walletAddress.trim().length === 0 || input.walletAddress.length > 300) {
      throw new ApiError(400, "Enter a wallet address.", "INVALID_REQUEST");
    }
    let wallet;
    try { wallet = await walletProvider.lookupWallet(input.walletAddress); } catch {
      throw new ApiError(422, "That Test Wallet address could not be found.", "WALLET_NOT_FOUND");
    }
    const id = randomUUID();
    const clientNonce = randomBytes(32).toString("base64url");
    let started: StartedWalletVerification;
    try {
      started = await verificationProvider.start(wallet, `${base}/api/wallet/callback/${id}`, clientNonce);
    } catch {
      throw new ApiError(502, "The wallet provider could not start verification.", "PROVIDER_UNAVAILABLE");
    }
    const sealed = encryption.encrypt(JSON.stringify({ clientNonce, started }), context(id));
    try {
      await pool.query(
        `INSERT INTO app_private.wallet_verifications
           (id, owner_user_id, wallet_address, auth_server_url, asset_code, asset_scale, public_name,
            secrets_ciphertext, key_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))`,
        [id, userId, wallet.id, wallet.authServer, wallet.assetCode, wallet.assetScale, wallet.publicName ?? null,
          sealed.ciphertext, sealed.keyVersion, now() + APPROVAL_TTL_MS],
      );
    } catch {
      await verificationProvider.cancel(started.continuation).catch(() => {});
      throw new ApiError(503, "Wallet verification could not be saved.", "STORAGE_UNAVAILABLE");
    }
    return { approvalId: id, status: "AWAITING_APPROVAL", authorizationUrl: started.redirectUrl };
  }

  async function getApproval(userId: number, id: unknown) {
    if (typeof id !== "string" || !UUID.test(id)) throw new ApiError(404, "Verification not found.", "NOT_FOUND");
    await pool.query(
      `UPDATE app_private.wallet_verifications
          SET status = CASE WHEN status = 'FINISHING' THEN 'FAILED' ELSE 'EXPIRED' END, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2
          AND ((status = 'AWAITING_APPROVAL' AND expires_at <= now())
            OR (status = 'FINISHING' AND updated_at < now() - interval '2 minutes'))`, [id, userId],
    );
    const result = await pool.query(
      "SELECT status, wallet_address FROM app_private.wallet_verifications WHERE id = $1 AND owner_user_id = $2",
      [id, userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "Verification not found.", "NOT_FOUND");
    return { approvalId: id, status: result.rows[0].status, walletAddress: result.rows[0].wallet_address };
  }

  async function callback(id: unknown, query: Record<string, unknown>) {
    if (typeof id !== "string" || !UUID.test(id)) return { status: 404, message: "Verification not found." };
    const { rows } = await pool.query("SELECT * FROM app_private.wallet_verifications WHERE id = $1", [id]);
    const row = rows[0];
    if (!row) return { status: 404, message: "Verification not found." };
    if (row.status !== "AWAITING_APPROVAL") return { status: 409, message: "Verification was already handled." };
    const secrets = JSON.parse(encryption.decrypt(
      { ciphertext: row.secrets_ciphertext, keyVersion: row.key_version }, context(id),
    )) as { clientNonce: string; started: StartedWalletVerification };
    if (new Date(row.expires_at).getTime() <= now()) {
      await pool.query("UPDATE app_private.wallet_verifications SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status = 'AWAITING_APPROVAL'", [id]);
      await verificationProvider.cancel(secrets.started.continuation).catch(() => {});
      return { status: 410, message: "Verification expired. Start again in the app." };
    }
    const ref = query.interact_ref;
    const hash = query.hash;
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 512 ||
        typeof hash !== "string" || hash.length > 512 ||
        !verifyInteractionHash(secrets.clientNonce, secrets.started.providerNonce, ref, secrets.started.grantRequestUrl, hash)) {
      return { status: 400, message: "The verification callback could not be verified." };
    }
    const claimed = await pool.query(
      `UPDATE app_private.wallet_verifications SET status = 'FINISHING', updated_at = now()
        WHERE id = $1 AND status = 'AWAITING_APPROVAL' AND expires_at > now() RETURNING id`, [id],
    );
    if (!claimed.rows[0]) return { status: 409, message: "Verification was already handled or expired." };
    try {
      await verificationProvider.finish(secrets.started, row.wallet_address, ref);
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const interaction = await db.query(
          "SELECT id FROM app_private.wallet_verifications WHERE id = $1 AND status = 'FINISHING' FOR UPDATE", [id],
        );
        if (!interaction.rows[0]) throw new Error("Verification is no longer active.");
        const linked = await db.query(
          `INSERT INTO app_private.verified_wallets (user_id, wallet_address, auth_server_url, asset_code, asset_scale, public_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
          [row.owner_user_id, row.wallet_address, row.auth_server_url, row.asset_code, row.asset_scale, row.public_name],
        );
        if (!linked.rows[0]) throw new Error("Account already has a verified wallet.");
        await db.query("UPDATE app_private.wallet_verifications SET status = 'VERIFIED', updated_at = now() WHERE id = $1", [id]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { db.release(); }
      return { status: 200, message: "Wallet verified. You can return to the app." };
    } catch {
      await pool.query("UPDATE app_private.wallet_verifications SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'FINISHING'", [id]);
      await verificationProvider.cancel(secrets.started.continuation).catch(() => {});
      return { status: 502, message: "Wallet verification could not be completed. Return to the app." };
    }
  }

  async function setupMerchant(userId: number, body: unknown) {
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (displayName.length < 2 || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new ApiError(400, "Merchant name must be 2 to 80 printable characters.", "INVALID_REQUEST");
    }
    const { rows } = await pool.query(
      `INSERT INTO app_private.merchants (user_id, display_name, receiving_wallet_address)
       SELECT user_id, $2, wallet_address FROM app_private.verified_wallets WHERE user_id = $1
       ON CONFLICT (user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, receiving_wallet_address = EXCLUDED.receiving_wallet_address
         WHERE merchants.status = 'ACTIVE'
       RETURNING id, display_name, receiving_wallet_address, status`,
      [userId, displayName],
    );
    if (!rows[0]) throw new ApiError(409, "Link a verified wallet and use an active merchant account.", "WALLET_REQUIRED");
    return { merchantId: rows[0].id, displayName: rows[0].display_name,
      walletAddress: rows[0].receiving_wallet_address, status: rows[0].status };
  }

  return { getWallet, start, getApproval, callback, setupMerchant };
}

export type VerifiedWalletService = ReturnType<typeof createVerifiedWalletService>;
