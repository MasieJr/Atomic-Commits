import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { ApiError } from "../errors/api-error";
import type { DataEncryption } from "./data-encryption";
import type { GrantAuthorityStore } from "./grant-authority-store";
import { verifyInteractionHash } from "./grant-interaction";
import type { LogEvent } from "./log";
import type { GrantContinuation, Money, RedemptionProvider, WalletInfo } from "./redemption-provider";

/*
 * Server-side payer consent (replaces the localhost grant:authorize script).
 *
 *   1. POST /api/payment-grants (logged-in payer): the server asks the payer's
 *      wallet for a bounded outgoing-payment grant and returns the approval
 *      link. Nonces + continuation are stored ENCRYPTED with a random id.
 *   2. The payer approves in the wallet, which redirects the browser to
 *      GET /api/open-payments/callback/:id. That request carries no app login:
 *      it is trusted only if the interaction is pending, unexpired, and the
 *      GNAP hash over both nonces + interact_ref + grant URL checks out.
 *   3. The server continues the grant, validates what the provider ACTUALLY
 *      granted, and stores it like grant:authorize did (tokens encrypted).
 *   4. The client polls GET /api/payment-grants/approvals/:id for the result.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINOR_PATTERN = /^[1-9][0-9]{0,17}$/;
const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
/* demo guard rails on what a client may ask for, in payer minor units */
const DEFAULT_CAP = "50000";
const DEFAULT_PER_PAYMENT = "5000";
const MAX_CAP = 1_000_000n;
const DEFAULT_VALID_HOURS = 24;

interface InteractionSecrets {
  clientNonce: string;
  providerNonce: string;
  grantRequestUrl: string;
  continuation: GrantContinuation;
}

export interface ApprovalView {
  readonly approvalId: string;
  readonly status: "AWAITING_APPROVAL" | "FINISHING" | "APPROVED" | "DENIED" | "FAILED" | "EXPIRED";
  readonly payerWalletAddress: string;
  readonly cumulativeCap: Money;
  readonly perPaymentMaxDebit: Money;
  readonly expiresAt: string;
  /** set once APPROVED: the grant id to enroll a device against */
  readonly authorizationId?: string;
  readonly errorCode?: string;
}

export interface CallbackResult {
  readonly status: number;
  readonly message: string;
}

function secretsContext(id: string): string {
  return `provider-interaction:${id}`;
}

function minorArg(value: unknown, fallback: string, name: string): bigint {
  if (value === undefined) return BigInt(fallback);
  if (typeof value !== "string" || !MINOR_PATTERN.test(value)) {
    throw new ApiError(400, `${name} must be a positive whole number of minor units, as a string.`, "INVALID_REQUEST");
  }
  return BigInt(value);
}

export function createPaymentGrantApprovalService(options: {
  pool: Pool;
  encryption: DataEncryption;
  authorities: GrantAuthorityStore;
  provider: RedemptionProvider;
  /** public base URL of this API, e.g. https://api.example.com (no trailing slash) */
  publicBaseUrl?: string;
  log: LogEvent;
  now?: () => number;
}) {
  const { pool, encryption, authorities, provider, log } = options;
  const now = options.now ?? Date.now;
  const baseUrl = options.publicBaseUrl?.trim().replace(/\/+$/, "");

  function view(row: Record<string, unknown>): ApprovalView {
    const money = (value: unknown): Money => ({
      value: String(value),
      assetCode: String(row.asset_code),
      assetScale: Number(row.asset_scale),
    });
    return {
      approvalId: String(row.id),
      status: row.status as ApprovalView["status"],
      payerWalletAddress: String(row.payer_wallet_address),
      cumulativeCap: money(row.cumulative_cap),
      perPaymentMaxDebit: money(row.per_payment_max_debit),
      expiresAt: new Date(row.expires_at as string).toISOString(),
      ...(row.grant_id ? { authorizationId: String(row.grant_id) } : {}),
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    };
  }

  async function startApproval(userId: number, body: unknown): Promise<ApprovalView & { authorizationUrl: string }> {
    if (!baseUrl) {
      throw new ApiError(503, "Server-side grant approval needs PUBLIC_BASE_URL to be configured.", "NOT_CONFIGURED");
    }
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (typeof input.walletAddress !== "string" || input.walletAddress.trim().length === 0 || input.walletAddress.length > 300) {
      throw new ApiError(400, "walletAddress is required (a $ payment pointer or https wallet URL).", "INVALID_REQUEST");
    }
    const cap = minorArg(input.cumulativeCap, DEFAULT_CAP, "cumulativeCap");
    const perPayment = minorArg(input.perPaymentMaxDebit, DEFAULT_PER_PAYMENT, "perPaymentMaxDebit");
    if (cap > MAX_CAP) throw new ApiError(400, `cumulativeCap may not exceed ${MAX_CAP} minor units.`, "INVALID_REQUEST");
    if (perPayment > cap) throw new ApiError(400, "perPaymentMaxDebit cannot exceed cumulativeCap.", "INVALID_REQUEST");

    let wallet: WalletInfo;
    try {
      wallet = await provider.lookupWallet(input.walletAddress);
    } catch {
      throw new ApiError(422, "That wallet address could not be found on the Test Wallet.", "WALLET_NOT_FOUND");
    }

    const id = randomUUID();
    const clientNonce = randomBytes(32).toString("base64url");
    const debitLimit: Money = { value: cap.toString(), assetCode: wallet.assetCode, assetScale: wallet.assetScale };
    let started;
    try {
      started = await provider.startOutgoingGrant({
        wallet,
        debitLimit,
        finishUri: `${baseUrl}/api/open-payments/callback/${id}`,
        clientNonce,
      });
    } catch {
      log("grant.approval.start_failed", { userId });
      throw new ApiError(502, "The wallet provider could not start the approval. Try again.", "PROVIDER_UNAVAILABLE");
    }
    const secrets: InteractionSecrets = {
      clientNonce,
      providerNonce: started.providerNonce,
      grantRequestUrl: started.grantRequestUrl,
      continuation: started.continuation,
    };
    const sealed = encryption.encrypt(JSON.stringify(secrets), secretsContext(id));
    const { rows } = await pool.query(
      `INSERT INTO app_private.provider_interactions
         (id, owner_user_id, payer_wallet_address, auth_server_url, asset_code, asset_scale,
          cumulative_cap, per_payment_max_debit, valid_hours, secrets_ciphertext, key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0))
       RETURNING *`,
      [
        id, userId, wallet.id, started.grantRequestUrl, wallet.assetCode, wallet.assetScale,
        cap.toString(), perPayment.toString(), DEFAULT_VALID_HOURS, sealed.ciphertext, sealed.keyVersion,
        now() + APPROVAL_WINDOW_MS,
      ],
    );
    log("grant.approval.started", { approvalId: id, userId });
    return { ...view(rows[0]), authorizationUrl: started.redirectUrl };
  }

  async function getApproval(userId: number, approvalId: unknown): Promise<ApprovalView> {
    if (typeof approvalId !== "string" || !UUID_PATTERN.test(approvalId)) {
      throw new ApiError(404, "Approval not found.", "NOT_FOUND");
    }
    const { rows } = await pool.query(
      "SELECT * FROM app_private.provider_interactions WHERE id = $1 AND owner_user_id = $2",
      [approvalId, userId],
    );
    if (!rows[0]) throw new ApiError(404, "Approval not found.", "NOT_FOUND");
    if (rows[0].status === "AWAITING_APPROVAL" && new Date(rows[0].expires_at).getTime() <= now()) {
      await setStatus(approvalId, "EXPIRED", "APPROVAL_EXPIRED", "AWAITING_APPROVAL");
      rows[0].status = "EXPIRED";
      rows[0].error_code = "APPROVAL_EXPIRED";
    }
    return view(rows[0]);
  }

  async function setStatus(id: string, status: string, errorCode: string | null, from?: string): Promise<void> {
    await pool.query(
      `UPDATE app_private.provider_interactions SET status = $2, error_code = $3, updated_at = now()
        WHERE id = $1 ${from ? "AND status = $4" : ""}`,
      from ? [id, status, errorCode, from] : [id, status, errorCode],
    );
  }

  /* the browser redirect from the wallet; no app login, so trust comes only from the checks below */
  async function handleCallback(approvalId: unknown, query: Record<string, unknown>): Promise<CallbackResult> {
    const notFound = { status: 404, message: "This approval link is not valid." };
    if (typeof approvalId !== "string" || !UUID_PATTERN.test(approvalId)) return notFound;
    const { rows } = await pool.query("SELECT * FROM app_private.provider_interactions WHERE id = $1", [approvalId]);
    const row = rows[0];
    if (!row) return notFound;
    if (row.status !== "AWAITING_APPROVAL") {
      return { status: 409, message: "This approval was already handled. You can return to the app." };
    }

    const secrets = JSON.parse(
      encryption.decrypt({ ciphertext: row.secrets_ciphertext, keyVersion: row.key_version }, secretsContext(row.id)),
    ) as InteractionSecrets;

    if (new Date(row.expires_at).getTime() <= now()) {
      await setStatus(row.id, "EXPIRED", "APPROVAL_EXPIRED", "AWAITING_APPROVAL");
      await provider.cancelGrant(secrets.continuation).catch(() => {});
      return { status: 410, message: "This approval expired. Please start again from the app." };
    }

    const single = (name: string): string | undefined => {
      const value = query[name];
      return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
    };
    /* the wallet reports a refusal with result/error instead of interact_ref */
    if (query.result !== undefined || query.error !== undefined) {
      await setStatus(row.id, "DENIED", "PAYER_DENIED", "AWAITING_APPROVAL");
      await provider.cancelGrant(secrets.continuation).catch(() => {});
      log("grant.approval.denied", { approvalId: row.id });
      return { status: 400, message: "The approval was cancelled. You can return to the app." };
    }
    const interactRef = single("interact_ref");
    const hash = single("hash");
    if (
      !interactRef ||
      !hash ||
      !verifyInteractionHash(secrets.clientNonce, secrets.providerNonce, interactRef, secrets.grantRequestUrl, hash)
    ) {
      /* not consumed: a forged or garbled callback must not cancel a genuine pending approval */
      log("grant.approval.callback_rejected", { approvalId: row.id });
      return { status: 400, message: "This approval could not be verified." };
    }

    /* claim it exactly once */
    const claimed = await pool.query(
      `UPDATE app_private.provider_interactions SET status = 'FINISHING', updated_at = now()
        WHERE id = $1 AND status = 'AWAITING_APPROVAL' RETURNING id`,
      [row.id],
    );
    if (!claimed.rows[0]) return { status: 409, message: "This approval was already handled. You can return to the app." };

    const wallet: WalletInfo = {
      id: row.payer_wallet_address,
      assetCode: row.asset_code,
      assetScale: row.asset_scale,
      authServer: row.auth_server_url,
    };
    const requestedDebit: Money = { value: String(row.cumulative_cap), assetCode: row.asset_code, assetScale: row.asset_scale };
    let finished;
    try {
      finished = await provider.finishOutgoingGrant({ continuation: secrets.continuation, interactRef, wallet, requestedDebit });
    } catch {
      await setStatus(row.id, "FAILED", "GRANT_NOT_FINALIZED");
      await provider.cancelGrant(secrets.continuation).catch(() => {});
      log("grant.approval.failed", { approvalId: row.id });
      return { status: 502, message: "The approval could not be completed. Please try again from the app." };
    }

    const grantedCap = BigInt(finished.grantedDebit.value);
    const perPayment = BigInt(row.per_payment_max_debit);
    if (
      finished.grantedDebit.assetCode !== row.asset_code ||
      finished.grantedDebit.assetScale !== row.asset_scale ||
      perPayment > grantedCap
    ) {
      await setStatus(row.id, "FAILED", "GRANT_TOO_SMALL");
      await provider.cancelGrant(finished.continuation).catch(() => {});
      return { status: 502, message: "The wallet granted less than needed. Please try again from the app." };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO app_private.payment_grants
           (payer_user_id, payer_wallet_address, authority_source, asset_code, asset_scale,
            cumulative_cap, per_payment_max_debit, valid_from, valid_until)
         VALUES ($1, $2, 'PROVIDER', $3, $4, $5, $6, now(), now() + make_interval(hours => $7))
         RETURNING id`,
        [row.owner_user_id, row.payer_wallet_address, row.asset_code, row.asset_scale, grantedCap.toString(), perPayment.toString(), row.valid_hours],
      );
      const grantId = inserted.rows[0].id as string;
      await authorities.saveAuthority(client, grantId, finished.authority);
      await authorities.saveContinuation(client, grantId, finished.continuation);
      await client.query(
        `UPDATE app_private.provider_interactions SET status = 'APPROVED', grant_id = $2, error_code = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, grantId],
      );
      await client.query("COMMIT");
      log("grant.approval.approved", { approvalId: row.id, authorizationId: grantId });
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      await setStatus(row.id, "FAILED", "STORAGE_FAILED");
      await provider.cancelGrant(finished.continuation).catch(() => {});
      return { status: 503, message: "The approval could not be saved. Please try again from the app." };
    } finally {
      client.release();
    }
    return { status: 200, message: "Approved. You can return to the app." };
  }

  return { startApproval, getApproval, handleCallback };
}

export type PaymentGrantApprovalService = ReturnType<typeof createPaymentGrantApprovalService>;
