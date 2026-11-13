import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { parsePaymentCode, verifyTotp } from "../domain/payment-engine/totp";
import { ApiError } from "../errors/api-error";
import { DataEncryptionError, type DataEncryption } from "./data-encryption";
import type { GrantAuthorityStore } from "./grant-authority-store";
import { silentLog, type LogEvent } from "./log";
import {
  isMoney,
  parseMinor,
  ProviderRejectedError,
  sameAsset,
  type Money,
  type OutgoingAuthority,
  type RedemptionProvider,
} from "./redemption-provider";
import { deviceSecretContext } from "./totp-enrollment";
import { createTotpReplayDigests } from "./totp-replay-digests";

/*
 * Merchant redemption of an offline TOTP payment code.
 *
 * The code is NOT a payment and NOT new consent: it only lets the backend use
 * spending authority the payer already approved, within its limits.
 *
 * Order of operations (each step persisted before the next network call):
 *   1. idempotency: same merchant + key + request returns the original attempt
 *   2. verify the code against the encrypted device secret (server time, drift 0)
 *   3. ONE transaction, device + grant rows locked:
 *        attempt row + single-use claim (device, timeStep) + recent-code replay
 *        guard + budget reservation
 *   4. fresh provider quote; payer debit checked against the reservation
 *   5. status SUBMITTING saved, then the outgoing payment is submitted ONCE
 *   6. confirmation read; unclear outcomes stay UNKNOWN with the reservation held
 * Nothing here ever re-submits a payment.
 */

export type AttemptStatus =
  | "AWAITING_AUTHORIZATION"
  | "SUBMITTING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "REJECTED";

export interface PaymentView {
  readonly paymentId: string;
  readonly status: AttemptStatus;
  readonly merchantName: string;
  readonly payerName: string;
  readonly merchantReceiveRequested: Money;
  readonly payerDebitQuoted?: Money;
  /** receipt: only present once the provider confirmed the payment */
  readonly payerDebitPaid?: Money;
  readonly merchantReceivePaid?: Money;
  readonly completedAt?: string;
  readonly providerIncomingRef?: string;
  readonly providerOutgoingRef?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RedemptionResult {
  readonly payment: PaymentView;
  /** true when this call created the attempt, false when it replayed an earlier one */
  readonly created: boolean;
}

export interface OfflineRedemptionOptions {
  readonly pool: Pool;
  readonly encryption: DataEncryption;
  readonly authorities: GrantAuthorityStore;
  readonly provider: RedemptionProvider;
  /** raw 32-byte data key; a separate subkey is derived for code digests */
  readonly dataKeys: ReadonlyMap<number, Buffer>;
  readonly now?: () => number;
  /** how long to wait for provider confirmation before answering PROCESSING */
  readonly confirmTimeoutMs?: number;
  readonly confirmPollMs?: number;
  readonly log?: LogEvent;
  /** 0 = code's own 30 s window only, 1 = also the adjacent windows (default) */
  readonly allowedDriftSteps?: 0 | 1;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** recent-code replay guard window: the same 6 digits on one device are refused for this long */
const REPLAY_GUARD_MINUTES = 10;
/** rotate the access token when it has less than this left */
const TOKEN_REFRESH_MARGIN_MS = 30_000;
/** a SUBMITTING row older than this is treated as UNKNOWN (process died mid-call) */
const STALE_SUBMITTING_MS = 2 * 60_000;
/*
 * Accept the code's own 30 s window plus one window either side, so a code
 * shown near the end of its window still works while the merchant types it.
 * Safe because every accepted code is claimed once per (device, time step)
 * AND by a keyed digest over a 10-minute window, whatever step it matched.
 * Set TOTP_ALLOWED_DRIFT_STEPS=0 for the strict single-window behaviour.
 */
const DEFAULT_ALLOWED_DRIFT_STEPS = 1;
/* a ROTATING grant older than this was left by a process that died mid-rotation */
const STUCK_ROTATION_MS = 2 * 60_000;

/* one generic answer for unknown prefix, wrong code, expired or revoked device */
const codeInvalid = () => new ApiError(422, "This payment code is invalid or expired.", "CODE_INVALID");

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

interface AttemptRow {
  id: string;
  status: AttemptStatus;
  request_fingerprint: string;
  merchant_receive_value: string;
  merchant_receive_asset_code: string;
  merchant_receive_asset_scale: number;
  payer_debit_value: string | null;
  payer_debit_asset_code: string | null;
  payer_debit_asset_scale: number | null;
  error_code: string | null;
  merchant_name: string;
  payer_name: string;
  provider_incoming_ref: string | null;
  provider_attempt_ref: string | null;
  payer_debit_paid_value: string | null;
  merchant_receive_paid_value: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toView(row: AttemptRow): PaymentView {
  return {
    paymentId: row.id,
    status: row.status,
    merchantName: row.merchant_name,
    payerName: row.payer_name,
    merchantReceiveRequested: {
      value: String(row.merchant_receive_value),
      assetCode: row.merchant_receive_asset_code,
      assetScale: row.merchant_receive_asset_scale,
    },
    ...(row.payer_debit_value !== null
      ? {
          payerDebitQuoted: {
            value: String(row.payer_debit_value),
            assetCode: row.payer_debit_asset_code!,
            assetScale: row.payer_debit_asset_scale!,
          },
        }
      : {}),
    ...(row.status === "SUCCEEDED" && row.payer_debit_paid_value !== null
      ? {
          payerDebitPaid: {
            value: String(row.payer_debit_paid_value),
            assetCode: row.payer_debit_asset_code!,
            assetScale: row.payer_debit_asset_scale!,
          },
        }
      : {}),
    ...(row.status === "SUCCEEDED" && row.merchant_receive_paid_value !== null
      ? {
          merchantReceivePaid: {
            value: String(row.merchant_receive_paid_value),
            assetCode: row.merchant_receive_asset_code,
            assetScale: row.merchant_receive_asset_scale,
          },
        }
      : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
    ...(row.status === "SUCCEEDED" && row.provider_incoming_ref ? { providerIncomingRef: row.provider_incoming_ref } : {}),
    ...(row.status === "SUCCEEDED" && row.provider_attempt_ref ? { providerOutgoingRef: row.provider_attempt_ref } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const ATTEMPT_SELECT = `SELECT a.id, a.status, a.request_fingerprint, a.merchant_receive_value,
  a.merchant_receive_asset_code, a.merchant_receive_asset_scale, a.payer_debit_value, a.payer_debit_asset_code,
  a.payer_debit_asset_scale, a.error_code, a.payer_debit_paid_value, a.merchant_receive_paid_value,
  a.completed_at, a.created_at, a.updated_at, a.provider_incoming_ref, a.provider_attempt_ref,
  m.display_name AS merchant_name, u.name AS payer_name
  FROM app_private.payment_attempts a JOIN app_private.merchants m ON m.id = a.merchant_id
  JOIN app_private.users u ON u.id = a.payer_user_id`;
export function createOfflineRedemptionService(options: OfflineRedemptionOptions) {
  const { pool, encryption, authorities, provider } = options;
  const now = options.now ?? Date.now;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 15_000;
  const confirmPollMs = options.confirmPollMs ?? 1_000;
  const log = options.log ?? silentLog;
  const allowedDriftSteps = options.allowedDriftSteps ?? DEFAULT_ALLOWED_DRIFT_STEPS;
  if (allowedDriftSteps !== 0 && allowedDriftSteps !== 1) throw new Error("allowedDriftSteps must be 0 or 1.");
  const replayDigests = createTotpReplayDigests(options.dataKeys);

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadAttempt(id: string): Promise<AttemptRow> {
    const { rows } = await pool.query(`${ATTEMPT_SELECT} WHERE a.id = $1`, [id]);
    return rows[0];
  }

  async function findByIdempotency(merchantId: string, key: string): Promise<AttemptRow | undefined> {
    const { rows } = await pool.query(
      `${ATTEMPT_SELECT} WHERE a.merchant_id = $1 AND a.idempotency_key = $2`,
      [merchantId, key],
    );
    return rows[0];
  }

  async function loadMerchant(userId: number) {
    const { rows } = await pool.query(
      `SELECT m.id, m.receiving_wallet_address FROM app_private.merchants m
         JOIN app_private.verified_wallets w ON w.user_id = m.user_id AND w.wallet_address = m.receiving_wallet_address
        WHERE m.user_id = $1 AND m.status = 'ACTIVE'`,
      [userId],
    );
    return rows[0] as { id: string; receiving_wallet_address: string } | undefined;
  }

  /* ends the attempt without debiting: reservation released, claim released */
  async function finishWithoutDebit(
    attemptId: string, status: "FAILED" | "REJECTED", errorCode: string,
    allowedStatuses: AttemptStatus[] = ["AWAITING_AUTHORIZATION", "SUBMITTING", "PROCESSING", "UNKNOWN"],
  ) {
    const ended = await releaseWithoutDebit(attemptId, status, errorCode, allowedStatuses);
    if (!ended) return;
    log("payment.ended_without_debit", { paymentId: attemptId, status, errorCode });
    /* close the merchant's unpaid incoming payment so it doesn't linger as EXPIRED (best effort) */
    try {
      const { rows } = await pool.query(
        `SELECT a.provider_incoming_ref, m.receiving_wallet_address
           FROM app_private.payment_attempts a JOIN app_private.merchants m ON m.id = a.merchant_id
          WHERE a.id = $1 AND a.status IN ('FAILED', 'REJECTED')`,
        [attemptId],
      );
      if (rows[0]?.provider_incoming_ref) {
        await provider.completeIncoming({
          incomingPaymentId: rows[0].provider_incoming_ref,
          merchantWalletAddress: rows[0].receiving_wallet_address,
        });
      }
    } catch {
      log("payment.incoming_close_failed", { paymentId: attemptId });
    }
  }

  async function releaseWithoutDebit(attemptId: string, status: "FAILED" | "REJECTED", errorCode: string, allowedStatuses: AttemptStatus[]) {
    return inTransaction(async (db) => {
      const changed = await db.query(
        `UPDATE app_private.payment_attempts SET status = $2, error_code = $3, updated_at = now()
          WHERE id = $1 AND status = ANY($4::text[]) RETURNING id`,
        [attemptId, status, errorCode, allowedStatuses],
      );
      if (!changed.rows[0]) return false;
      await db.query(
        `UPDATE app_private.spending_reservations r SET state = 'RELEASED', updated_at = now()
           FROM app_private.totp_code_claims c
          WHERE r.claim_id = c.id AND c.payment_attempt_id = $1 AND r.state IN ('RESERVED', 'HELD_UNKNOWN')`,
        [attemptId],
      );
      await db.query(
        `UPDATE app_private.totp_code_claims SET state = 'RELEASED' WHERE payment_attempt_id = $1 AND state <> 'COMPLETED'`,
        [attemptId],
      );
      return true;
    });
  }

  async function markUnknown(attemptId: string) {
    log("payment.unknown", { paymentId: attemptId });
    await inTransaction(async (db) => {
      await db.query(
        `UPDATE app_private.payment_attempts SET status = 'UNKNOWN', updated_at = now()
          WHERE id = $1 AND status IN ('SUBMITTING', 'PROCESSING')`,
        [attemptId],
      );
      await db.query(
        `UPDATE app_private.spending_reservations r SET state = 'HELD_UNKNOWN', updated_at = now()
           FROM app_private.totp_code_claims c
          WHERE r.claim_id = c.id AND c.payment_attempt_id = $1 AND r.state = 'RESERVED'`,
        [attemptId],
      );
      await db.query(
        "UPDATE app_private.totp_code_claims SET state = 'HELD_UNKNOWN' WHERE payment_attempt_id = $1 AND state = 'CLAIMED'",
        [attemptId],
      );
    });
  }

  /* provider-confirmed success: commit the reservation and count the spend, once */
  async function markSucceeded(attemptId: string, sent: Money, received: Money) {
    const changed = await inTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE app_private.payment_attempts
            SET status = 'SUCCEEDED', error_code = NULL, updated_at = now(), completed_at = now(),
                payer_debit_paid_value = $2, merchant_receive_paid_value = $3
          WHERE id = $1 AND status IN ('PROCESSING', 'UNKNOWN')
          RETURNING grant_id, payer_debit_value`,
        [attemptId, parseMinor(sent.value)?.toString() ?? null, parseMinor(received.value)?.toString() ?? null],
      );
      if (!rows[0]) return false; /* already finalized by someone else */
      await db.query(
        `UPDATE app_private.spending_reservations r SET state = 'COMMITTED', updated_at = now()
           FROM app_private.totp_code_claims c
          WHERE r.claim_id = c.id AND c.payment_attempt_id = $1`,
        [attemptId],
      );
      await db.query(
        `UPDATE app_private.payment_grants SET cumulative_spent = cumulative_spent + $2, updated_at = now()
          WHERE id = $1`,
        [rows[0].grant_id, rows[0].payer_debit_value],
      );
      await db.query("UPDATE app_private.totp_code_claims SET state = 'COMPLETED' WHERE payment_attempt_id = $1", [
        attemptId,
      ]);
      return true;
    });
    if (changed) log("payment.succeeded", { paymentId: attemptId });
  }

  /*
   * Returns a usable access token, rotating it in place when close to expiry.
   * Rotation is guarded by the grant status (ACTIVE -> ROTATING) so only one
   * process rotates at a time; a refused rotation needs the payer, an unclear
   * one blocks the grant.
   */
  async function freshAuthority(grantId: string): Promise<OutgoingAuthority> {
    const current = await authorities.loadAuthority(pool, grantId);
    if (!current) throw new ApiError(409, "This grant has no stored provider authority.", "GRANT_NOT_SPENDABLE");
    if (current.expiresAtEpochMs === undefined || !Number.isSafeInteger(current.expiresAtEpochMs)) {
      await pool.query(
        "UPDATE app_private.payment_grants SET status = 'REAUTHORIZATION_REQUIRED', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'",
        [grantId],
      );
      throw new ApiError(409, "The payer's authority has no verifiable expiry.", "GRANT_NOT_SPENDABLE");
    }
    if (current.expiresAtEpochMs > now() + TOKEN_REFRESH_MARGIN_MS) {
      return current;
    }
    const lock = await pool.query(
      `UPDATE app_private.payment_grants SET status = 'ROTATING', updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
      [grantId],
    );
    if (!lock.rows[0]) throw new ApiError(503, "The payer's authority is being refreshed. Try again shortly.", "GRANT_BUSY");
    let rotated: OutgoingAuthority;
    try {
      rotated = await provider.rotateAuthority(current);
    } catch (error) {
      const next = error instanceof ProviderRejectedError ? "REAUTHORIZATION_REQUIRED" : "BLOCKED";
      /* only from ROTATING: a revocation that happened meanwhile wins */
      await pool.query(
        "UPDATE app_private.payment_grants SET status = $2, updated_at = now() WHERE id = $1 AND status = 'ROTATING'",
        [grantId, next],
      );
      log("grant.rotation_failed", { authorizationId: grantId, next });
      throw new ApiError(409, "The payer's authority could not be refreshed.", "GRANT_NOT_SPENDABLE");
    }
    /* the old token may already be dead, so the new one is always saved */
    const usable = rotated.accessToken !== current.accessToken && Boolean(rotated.manageUrl) &&
      Number.isSafeInteger(rotated.expiresAtEpochMs) && rotated.expiresAtEpochMs! > now() + TOKEN_REFRESH_MARGIN_MS;
    const stillRotating = await inTransaction(async (db) => {
      await authorities.saveAuthority(db, grantId, rotated);
      const back = await db.query(
        "UPDATE app_private.payment_grants SET status = $2, updated_at = now() WHERE id = $1 AND status = 'ROTATING' RETURNING id",
        [grantId, usable ? "ACTIVE" : "REAUTHORIZATION_REQUIRED"],
      );
      return Boolean(back.rows[0]);
    });
    if (!stillRotating) {
      /* revoked (or blocked) while we were rotating: never spend with it */
      throw new ApiError(409, "The payer's approval changed while it was being refreshed.", "GRANT_NOT_SPENDABLE");
    }
    if (!usable) throw new ApiError(409, "The refreshed authority is not verifiable.", "GRANT_NOT_SPENDABLE");
    return rotated;
  }

  /*
   * Token for READ-ONLY provider calls. Access tokens live ~10 minutes, so a
   * payment confirmed later needs a rotated one. Rotation only happens for an
   * ACTIVE grant; otherwise the stored token is tried as is.
   */
  async function readAuthority(grantId: string): Promise<OutgoingAuthority | undefined> {
    const current = await authorities.loadAuthority(pool, grantId);
    if (!current) return undefined;
    if (current.expiresAtEpochMs === undefined || current.expiresAtEpochMs > now() + TOKEN_REFRESH_MARGIN_MS) {
      return current;
    }
    const { rows } = await pool.query("SELECT status FROM app_private.payment_grants WHERE id = $1", [grantId]);
    if (rows[0]?.status !== "ACTIVE") return current;
    try {
      return await freshAuthority(grantId);
    } catch {
      return (await authorities.loadAuthority(pool, grantId)) ?? current;
    }
  }

  async function confirm(attemptId: string, deadlineMs: number): Promise<void> {
    const { rows } = await pool.query(
      `SELECT a.status, a.provider_attempt_ref, a.provider_incoming_ref, a.provider_quote_ref, a.grant_id,
              a.payer_debit_value, a.payer_debit_asset_code, a.payer_debit_asset_scale, a.updated_at,
              a.merchant_receive_value, a.merchant_receive_asset_code, a.merchant_receive_asset_scale,
              m.receiving_wallet_address, g.payer_wallet_address
         FROM app_private.payment_attempts a
         JOIN app_private.merchants m ON m.id = a.merchant_id
         JOIN app_private.payment_grants g ON g.id = a.grant_id
        WHERE a.id = $1`,
      [attemptId],
    );
    const row = rows[0];
    if (!row) return;
    if (!row.provider_attempt_ref) {
      /* crashed or timed out mid-submit: ask the provider (read-only) whether it exists */
      if (row.status !== "UNKNOWN" || !row.provider_quote_ref) return;
      let found;
      try {
        const authority = await readAuthority(row.grant_id);
        if (!authority) return;
        found = await provider.findOutgoingByQuote({
          payerWalletAddress: row.payer_wallet_address,
          quoteId: row.provider_quote_ref,
          authority,
        });
      } catch {
        return; /* can't tell: stay UNKNOWN, budget held */
      }
      // Absence from a provider listing is not definitive proof that no debit
      // happened. Keep the claim and budget reserved until an outcome is found.
      if (!found) return;
      await pool.query(
        `UPDATE app_private.payment_attempts SET provider_attempt_ref = $2, status = 'PROCESSING', updated_at = now()
          WHERE id = $1 AND status = 'UNKNOWN' AND provider_attempt_ref IS NULL`,
        [attemptId, found.outgoingPaymentId],
      );
      row.provider_attempt_ref = found.outgoingPaymentId;
    }
    do {
      let outcome;
      try {
        const authority = await readAuthority(row.grant_id);
        if (!authority) return;
        outcome = await provider.readOutcome({
          outgoingPaymentId: row.provider_attempt_ref,
          incomingPaymentId: row.provider_incoming_ref,
          quoteId: row.provider_quote_ref,
          payerWalletAddress: row.payer_wallet_address,
          merchantWalletAddress: row.receiving_wallet_address,
          expectedDebit: {
            value: String(row.payer_debit_value),
            assetCode: row.payer_debit_asset_code,
            assetScale: row.payer_debit_asset_scale,
          },
          expectedReceive: {
            value: String(row.merchant_receive_value),
            assetCode: row.merchant_receive_asset_code,
            assetScale: row.merchant_receive_asset_scale,
          },
          authority,
        });
      } catch {
        outcome = { kind: "PENDING" as const }; /* a failed READ is retried, never the debit */
      }
      if (outcome.kind === "SUCCEEDED") return markSucceeded(attemptId, outcome.sent, outcome.received);
      if (outcome.kind === "FAILED") return finishWithoutDebit(attemptId, "FAILED", "PROVIDER_FAILED");
      if (now() + confirmPollMs > deadlineMs) return;
      await new Promise((resolve) => setTimeout(resolve, confirmPollMs));
    } while (now() < deadlineMs);
  }

  async function redeem(args: {
    userId: number;
    idempotencyKey: unknown;
    body: unknown;
  }): Promise<RedemptionResult> {
    const merchant = await loadMerchant(args.userId);
    if (!merchant) throw new ApiError(403, "Only merchant accounts can redeem payment codes.", "NOT_A_MERCHANT");

    if (typeof args.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(args.idempotencyKey)) {
      throw new ApiError(400, "Send an Idempotency-Key header (8-128 letters, digits, - or _).", "IDEMPOTENCY_KEY_REQUIRED");
    }
    const key = args.idempotencyKey;
    const body =
      typeof args.body === "object" && args.body !== null && !Array.isArray(args.body)
        ? (args.body as Record<string, unknown>)
        : {};
    if (body.credentialType !== "totp-v1" || typeof body.paymentCode !== "string" || !isMoney(body.merchantReceive)) {
      throw new ApiError(
        400,
        "Body must be { credentialType: 'totp-v1', paymentCode: 'PREFIX-123456', merchantReceive: { value, assetCode, assetScale } }.",
        "INVALID_REQUEST",
      );
    }
    const receive = body.merchantReceive as Money;
    if (parseMinor(receive.value)! <= 0n) {
      throw new ApiError(400, "merchantReceive.value must be a positive whole number of minor units.", "INVALID_REQUEST");
    }
    const paymentCode = body.paymentCode;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["totp-v1", paymentCode, receive.value, receive.assetCode, receive.assetScale]))
      .digest("hex");

    /* 1. idempotent replay */
    const existing = await findByIdempotency(merchant.id, key);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new ApiError(409, "This Idempotency-Key was already used for a different request.", "IDEMPOTENCY_CONFLICT");
      }
      return { payment: toView(existing), created: false };
    }

    /* 2. verify the code with the server clock */
    const parsed = parsePaymentCode(paymentCode);
    if (!parsed) throw codeInvalid();
    const nowMs = now();
    const { rows: devices } = await pool.query(
      `SELECT d.id, d.payer_user_id, d.authorization_id, d.secret_ciphertext, d.key_version
         FROM app_private.totp_devices d
        WHERE d.prefix = $1 AND d.status = 'ACTIVE' AND d.expires_at > to_timestamp($2 / 1000.0)`,
      [parsed.prefix, nowMs],
    );
    const device = devices[0];
    if (!device) throw codeInvalid();
    let secret: string;
    try {
      secret = encryption.decrypt(
        { ciphertext: device.secret_ciphertext, keyVersion: device.key_version },
        deviceSecretContext(device.id),
      );
    } catch (error) {
      if (error instanceof DataEncryptionError) throw codeInvalid();
      throw error;
    }
    const verification = verifyTotp(secret, parsed.code, nowMs, allowedDriftSteps);
    if (!verification.valid) throw codeInvalid();
    const digestsByVersion = replayDigests(device.id, parsed.code);
    const codeDigest = digestsByVersion.get(device.key_version);
    if (!codeDigest) throw codeInvalid();
    const codeDigests = [...digestsByVersion.values()];

    /* 3. claim + reservation, atomically */
    let attemptId: string;
    let grant: {
      payer_wallet_address: string;
      asset_code: string;
      asset_scale: number;
      reserved: bigint;
    };
    try {
      ({ attemptId, grant } = await inTransaction(async (db) => {
        const { rows: grants } = await db.query(
          `SELECT id, status, authority_source, payer_wallet_address, asset_code, asset_scale,
                  cumulative_cap, per_payment_max_debit, cumulative_spent, valid_from, valid_until
             FROM app_private.payment_grants g WHERE id = $1 AND payer_user_id = $2
              AND EXISTS (SELECT 1 FROM app_private.verified_wallets w
                           WHERE w.user_id = g.payer_user_id AND w.wallet_address = g.payer_wallet_address)
              FOR UPDATE`,
          [device.authorization_id, device.payer_user_id],
        );
        const g = grants[0];
        if (!g) throw codeInvalid();
        /* Match grant revocation's lock order: grant first, then device. */
        const lockedDevice = await db.query(
          "SELECT status, expires_at FROM app_private.totp_devices WHERE id = $1 FOR UPDATE",
          [device.id],
        );
        const lockedNow = now();
        const refreshedVerification = verifyTotp(secret, parsed.code, lockedNow, allowedDriftSteps);
        if (lockedDevice.rows[0]?.status !== "ACTIVE" || new Date(lockedDevice.rows[0].expires_at).getTime() <= lockedNow ||
            !refreshedVerification.valid || refreshedVerification.timeStep !== verification.timeStep) throw codeInvalid();
        if (g.authority_source !== "PROVIDER") {
          throw new ApiError(409, "This device is linked to a demo placeholder grant that cannot move money.", "DEMO_GRANT");
        }
        if (
          g.status !== "ACTIVE" ||
          lockedNow < new Date(g.valid_from).getTime() ||
          lockedNow >= new Date(g.valid_until).getTime()
        ) {
          throw new ApiError(409, "The payer's spending approval is not usable right now.", "GRANT_NOT_SPENDABLE");
        }

        /* replay guard: same 6 digits on this device recently = refused, whatever the time step */
        const recent = await db.query(
          `SELECT 1 FROM app_private.totp_code_claims
            WHERE device_id = $1 AND code_digest = ANY($2::bytea[]) AND created_at > now() - make_interval(mins => $3)`,
          [device.id, codeDigests, REPLAY_GUARD_MINUTES],
        );
        if (recent.rows[0]) throw new ApiError(409, "This payment code was already used.", "CODE_ALREADY_USED");

        /* budget: spent + active reservations + this reservation must fit the cap */
        const { rows: held } = await db.query(
          `SELECT COALESCE(SUM(amount), 0)::text AS total FROM app_private.spending_reservations
            WHERE grant_id = $1 AND state IN ('RESERVED', 'HELD_UNKNOWN')`,
          [g.id],
        );
        const remaining = BigInt(g.cumulative_cap) - BigInt(g.cumulative_spent) - BigInt(held[0].total);
        const perPayment = BigInt(g.per_payment_max_debit);
        const reserve = remaining < perPayment ? remaining : perPayment;
        if (reserve <= 0n) {
          throw new ApiError(409, "The payer's approved spending limit has been reached.", "INSUFFICIENT_GRANT_BUDGET");
        }

        let attempt;
        try {
          attempt = await db.query(
            `INSERT INTO app_private.payment_attempts
               (payer_user_id, merchant_id, grant_id, device_id, idempotency_key, request_fingerprint, status,
                merchant_receive_value, merchant_receive_asset_code, merchant_receive_asset_scale)
             VALUES ($1, $2, $3, $4, $5, $6, 'AWAITING_AUTHORIZATION', $7, $8, $9)
             RETURNING id`,
            [
              device.payer_user_id, merchant.id, g.id, device.id, key, fingerprint,
              receive.value, receive.assetCode, receive.assetScale,
            ],
          );
        } catch (error) {
          if (isUniqueViolation(error, "payment_attempts_merchant_id_idempotency_key_key")) throw new RaceReplay();
          throw error;
        }
        const id = attempt.rows[0].id as string;

        let claim;
        try {
          claim = await db.query(
            `INSERT INTO app_private.totp_code_claims
               (device_id, time_step, code_digest, merchant_id, request_fingerprint, payment_attempt_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [device.id, verification.timeStep, codeDigest, merchant.id, fingerprint, id],
          );
        } catch (error) {
          if (isUniqueViolation(error, "totp_code_claims_device_id_time_step_key")) {
            throw new ApiError(409, "This payment code was already used.", "CODE_ALREADY_USED");
          }
          throw error;
        }
        await db.query(
          "INSERT INTO app_private.spending_reservations (grant_id, claim_id, amount) VALUES ($1, $2, $3)",
          [g.id, claim.rows[0].id, reserve.toString()],
        );
        return {
          attemptId: id,
          grant: {
            payer_wallet_address: g.payer_wallet_address,
            asset_code: g.asset_code,
            asset_scale: g.asset_scale,
            reserved: reserve,
          },
        };
      }));
    } catch (error) {
      if (error instanceof RaceReplay) {
        /* a concurrent identical request won the race: answer like a replay */
        const winner = await findByIdempotency(merchant.id, key);
        if (winner && winner.request_fingerprint === fingerprint) return { payment: toView(winner), created: false };
        throw new ApiError(409, "This Idempotency-Key was already used for a different request.", "IDEMPOTENCY_CONFLICT");
      }
      throw error;
    }

    /* 4. fresh quote; the payer debit must fit what we reserved */
    let quote;
    try {
      quote = await provider.prepareQuote({
        payerWalletAddress: grant.payer_wallet_address,
        merchantWalletAddress: merchant.receiving_wallet_address,
        merchantReceive: receive,
        reference: attemptId,
      });
    } catch {
      await finishWithoutDebit(attemptId, "FAILED", "QUOTE_FAILED");
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    /* remember the provider refs first, so a rejected quote's incoming payment can be closed */
    await pool.query(
      `UPDATE app_private.payment_attempts SET provider_incoming_ref = $2, provider_quote_ref = $3, updated_at = now()
        WHERE id = $1`,
      [attemptId, quote.incomingPaymentId, quote.quoteId],
    );
    const debit = parseMinor(quote.debit.value);
    if (quote.expiresAtEpochMs !== undefined &&
        (!Number.isSafeInteger(quote.expiresAtEpochMs) || quote.expiresAtEpochMs <= now())) {
      await finishWithoutDebit(attemptId, "REJECTED", "QUOTE_EXPIRED");
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    if (
      debit === undefined ||
      debit <= 0n ||
      !sameAsset(quote.debit, { assetCode: grant.asset_code, assetScale: grant.asset_scale })
    ) {
      await finishWithoutDebit(attemptId, "REJECTED", "QUOTE_ASSET_MISMATCH");
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    if (debit > grant.reserved) {
      await finishWithoutDebit(attemptId, "REJECTED", "QUOTE_EXCEEDS_LIMIT");
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    await inTransaction(async (db) => {
      await db.query(
        `UPDATE app_private.payment_attempts
            SET provider_incoming_ref = $2, provider_quote_ref = $3, payer_debit_value = $4,
                payer_debit_asset_code = $5, payer_debit_asset_scale = $6, updated_at = now()
          WHERE id = $1`,
        [attemptId, quote.incomingPaymentId, quote.quoteId, debit.toString(), quote.debit.assetCode, quote.debit.assetScale],
      );
      /* shrink the hold to the real debit */
      await db.query(
        `UPDATE app_private.spending_reservations r SET amount = $2, updated_at = now()
           FROM app_private.totp_code_claims c
          WHERE r.claim_id = c.id AND c.payment_attempt_id = $1`,
        [attemptId, debit.toString()],
      );
    });

    /* 5. submit exactly once */
    let authority: OutgoingAuthority;
    try {
      authority = await freshAuthority((await pool.query(
        "SELECT grant_id FROM app_private.payment_attempts WHERE id = $1", [attemptId],
      )).rows[0].grant_id);
    } catch (error) {
      await finishWithoutDebit(attemptId, "FAILED", error instanceof ApiError && error.code ? error.code : "GRANT_NOT_SPENDABLE");
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    const moved = await inTransaction(async (db) => {
      const grantState = await db.query(
        `SELECT status, valid_from, valid_until FROM app_private.payment_grants
          WHERE id = $1 AND payer_user_id = $2 FOR UPDATE`,
        [device.authorization_id, device.payer_user_id],
      );
      const deviceState = await db.query(
        "SELECT status, expires_at FROM app_private.totp_devices WHERE id = $1 FOR UPDATE", [device.id],
      );
      const d = deviceState.rows[0];
      const g = grantState.rows[0];
      const at = now();
      if (!d || d.status !== "ACTIVE" || new Date(d.expires_at).getTime() <= at ||
          !g || g.status !== "ACTIVE" || new Date(g.valid_from).getTime() > at || new Date(g.valid_until).getTime() <= at ||
          (quote.expiresAtEpochMs !== undefined && quote.expiresAtEpochMs <= at)) return false;
      const update = await db.query(
        `UPDATE app_private.payment_attempts SET status = 'SUBMITTING', updated_at = now()
          WHERE id = $1 AND status = 'AWAITING_AUTHORIZATION' RETURNING id`, [attemptId],
      );
      return Boolean(update.rows[0]);
    });
    if (!moved) {
      await finishWithoutDebit(attemptId, "FAILED", "GRANT_NOT_SPENDABLE", ["AWAITING_AUTHORIZATION"]);
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }
    try {
      const { outgoingPaymentId } = await provider.submitPayment({
        payerWalletAddress: grant.payer_wallet_address,
        quoteId: quote.quoteId,
        authority,
      });
      await pool.query(
        `UPDATE app_private.payment_attempts SET status = 'PROCESSING', provider_attempt_ref = $2, updated_at = now()
          WHERE id = $1 AND status = 'SUBMITTING'`,
        [attemptId, outgoingPaymentId],
      );
    } catch (error) {
      if (error instanceof ProviderRejectedError) await finishWithoutDebit(attemptId, "FAILED", "PROVIDER_REJECTED");
      else await markUnknown(attemptId);
      return { payment: toView(await loadAttempt(attemptId)), created: true };
    }

    /* 6. short confirmation wait; the merchant can keep polling GET /api/payments/:id */
    await confirm(attemptId, now() + confirmTimeoutMs);
    return { payment: toView(await loadAttempt(attemptId)), created: true };
  }

  /* payer or merchant of this payment only; a read may reconcile, never re-submit */
  async function getPayment(userId: number, paymentId: unknown): Promise<PaymentView> {
    if (typeof paymentId !== "string" || !UUID_PATTERN.test(paymentId)) {
      throw new ApiError(404, "Payment not found.", "NOT_FOUND");
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.status, a.updated_at, a.provider_attempt_ref
         FROM app_private.payment_attempts a
         JOIN app_private.merchants m ON m.id = a.merchant_id
        WHERE a.id = $1 AND (a.payer_user_id = $2 OR m.user_id = $2)`,
      [paymentId, userId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, "Payment not found.", "NOT_FOUND");

    if (row.status === "SUBMITTING" && now() - new Date(row.updated_at).getTime() > STALE_SUBMITTING_MS) {
      await markUnknown(row.id);
    }
    if (["PROCESSING", "UNKNOWN", "SUBMITTING"].includes(row.status)) {
      await confirm(row.id, now()); /* one read-only check */
    }
    return toView(await loadAttempt(row.id));
  }

  /* the caller's receipts: payments they made (payer) or received (merchant) */
  async function listPayments(userId: number): Promise<{ asPayer: PaymentView[]; asMerchant: PaymentView[] }> {
    const [payer, merchant] = await Promise.all([
      pool.query(`${ATTEMPT_SELECT} WHERE a.payer_user_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [userId]),
      pool.query(`${ATTEMPT_SELECT} WHERE m.user_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [userId]),
    ]);
    return { asPayer: payer.rows.map(toView), asMerchant: merchant.rows.map(toView) };
  }

  /*
   * Crash recovery, run at startup and periodically: a SUBMITTING row left by a
   * dead process becomes UNKNOWN (budget held), then every unresolved attempt
   * gets one read-only provider check. Nothing is ever re-submitted.
   */
  async function reconcilePending(): Promise<{ checked: number }> {
    const availableVersions = [...options.dataKeys.keys()];
    /* a rotation that never finished: the old token may be dead and the new one unknown */
    const stuck = await pool.query(
      `UPDATE app_private.payment_grants g SET status = 'BLOCKED', updated_at = now()
        WHERE status = 'ROTATING' AND updated_at < now() - make_interval(secs => $1)
          AND EXISTS (SELECT 1 FROM app_private.provider_credentials c WHERE c.grant_id = g.id
                       AND c.kind = 'ACCESS_TOKEN' AND c.key_version = ANY($2::smallint[]))
        RETURNING g.id`,
      [STUCK_ROTATION_MS / 1000, availableVersions],
    );
    for (const { id } of stuck.rows) log("grant.rotation_abandoned", { authorizationId: id });
    const { rows: stale } = await pool.query(
      `SELECT a.id FROM app_private.payment_attempts a
        WHERE a.status = 'SUBMITTING' AND a.updated_at < now() - make_interval(secs => $1)
          AND EXISTS (SELECT 1 FROM app_private.provider_credentials c WHERE c.grant_id = a.grant_id
                       AND c.kind = 'ACCESS_TOKEN' AND c.key_version = ANY($2::smallint[]))`,
      [STALE_SUBMITTING_MS / 1000, availableVersions],
    );
    for (const { id } of stale) await markUnknown(id);
    const { rows } = await pool.query(
      `SELECT a.id FROM app_private.payment_attempts a WHERE a.status IN ('PROCESSING', 'UNKNOWN')
        AND EXISTS (SELECT 1 FROM app_private.provider_credentials c WHERE c.grant_id = a.grant_id
                     AND c.kind = 'ACCESS_TOKEN' AND c.key_version = ANY($1::smallint[]))
        ORDER BY a.updated_at LIMIT 50`, [availableVersions],
    );
    for (const { id } of rows) {
      try {
        await confirm(id, now());
      } catch {
        /* keep going; this attempt stays unresolved */
      }
    }
    return { checked: rows.length };
  }

  return { redeem, getPayment, listPayments, reconcilePending };
}

class RaceReplay extends Error {}

export type OfflineRedemptionService = ReturnType<typeof createOfflineRedemptionService>;
