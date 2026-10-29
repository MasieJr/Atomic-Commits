import type { Pool } from "pg";

import { ApiError } from "../errors/api-error";
import type { GrantAuthorityStore } from "./grant-authority-store";
import { silentLog, type LogEvent } from "./log";
import { ProviderRejectedError, ProviderUnknownError, type Money, type RedemptionProvider } from "./redemption-provider";

/*
 * Payer-facing view and revocation of spending grants.
 *
 * Revocation is LOCAL FIRST: one transaction marks the grant REVOKED and
 * revokes its devices, so no new debit can start from that moment, whatever
 * the provider says. The provider-side cancellation is tracked separately. It
 * is deferred while a payment is still unresolved, because cancelling would
 * also kill the token needed to find out whether that payment went through.
 */

export interface GrantView {
  readonly authorizationId: string;
  readonly status: string;
  readonly authoritySource: "PROVIDER" | "DEMO_PLACEHOLDER";
  readonly payerWalletAddress: string;
  readonly cumulativeCap: Money;
  readonly perPaymentMaxDebit: Money;
  readonly spent: Money;
  readonly reserved: Money;
  readonly remaining: Money;
  readonly validUntil: string;
  readonly providerRevocation: string;
  readonly revokedAt?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GRANT_SELECT = `SELECT g.id, g.status, g.authority_source, g.payer_wallet_address, g.asset_code, g.asset_scale,
    g.cumulative_cap, g.per_payment_max_debit, g.cumulative_spent, g.valid_until, g.provider_revocation, g.revoked_at,
    COALESCE((SELECT SUM(r.amount) FROM app_private.spending_reservations r
               WHERE r.grant_id = g.id AND r.state IN ('RESERVED', 'HELD_UNKNOWN')), 0)::text AS reserved
  FROM app_private.payment_grants g`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any): GrantView {
  const money = (value: bigint | string): Money => ({
    value: BigInt(value) < 0n ? "0" : BigInt(value).toString(),
    assetCode: row.asset_code,
    assetScale: row.asset_scale,
  });
  const remaining = BigInt(row.cumulative_cap) - BigInt(row.cumulative_spent) - BigInt(row.reserved);
  return {
    authorizationId: row.id,
    status: row.status,
    authoritySource: row.authority_source,
    payerWalletAddress: row.payer_wallet_address,
    cumulativeCap: money(row.cumulative_cap),
    perPaymentMaxDebit: money(row.per_payment_max_debit),
    spent: money(row.cumulative_spent),
    reserved: money(row.reserved),
    remaining: money(remaining),
    validUntil: new Date(row.valid_until).toISOString(),
    providerRevocation: row.provider_revocation,
    ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}),
  };
}

export function createPaymentGrantService(options: {
  pool: Pool;
  authorities: GrantAuthorityStore;
  provider: RedemptionProvider;
  log?: LogEvent;
}) {
  const { pool, authorities, provider } = options;
  const log = options.log ?? silentLog;

  async function getGrant(userId: number, grantId: unknown): Promise<GrantView> {
    if (typeof grantId !== "string" || !UUID_PATTERN.test(grantId)) throw new ApiError(404, "Grant not found.", "NOT_FOUND");
    const { rows } = await pool.query(`${GRANT_SELECT} WHERE g.id = $1 AND g.payer_user_id = $2`, [grantId, userId]);
    if (!rows[0]) throw new ApiError(404, "Grant not found.", "NOT_FOUND");
    return toView(rows[0]);
  }

  async function listGrants(userId: number): Promise<GrantView[]> {
    const { rows } = await pool.query(`${GRANT_SELECT} WHERE g.payer_user_id = $1 ORDER BY g.created_at DESC`, [userId]);
    return rows.map(toView);
  }

  async function revokeGrant(userId: number, grantId: unknown): Promise<GrantView> {
    const before = await getGrant(userId, grantId); /* ownership check, 404 otherwise */
    const id = before.authorizationId;

    /* 1. local block, immediately and atomically */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        `UPDATE app_private.payment_grants
            SET status = 'REVOKED', revocation_version = revocation_version + 1, revoked_at = now(), updated_at = now(),
                provider_revocation = CASE WHEN authority_source = 'PROVIDER' THEN 'PENDING' ELSE 'NOT_REQUIRED' END
          WHERE id = $1 AND payer_user_id = $2 AND status <> 'REVOKED'
          RETURNING id`,
        [id, userId],
      );
      if (changed.rows[0]) {
        await client.query(
          `UPDATE app_private.totp_devices
              SET status = 'REVOKED', revoked_at = now(), revocation_version = revocation_version + 1
            WHERE authorization_id = $1 AND status = 'ACTIVE'`,
          [id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    /* 2. provider cancellation (retried by calling revoke again) */
    await cancelAtProvider(id);
    return getGrant(userId, id);
  }

  async function cancelAtProvider(grantId: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT provider_revocation,
              EXISTS (SELECT 1 FROM app_private.payment_attempts a
                       WHERE a.grant_id = g.id
                         AND a.status IN ('AWAITING_AUTHORIZATION', 'SUBMITTING', 'PROCESSING', 'UNKNOWN')) AS unresolved
         FROM app_private.payment_grants g WHERE g.id = $1 AND g.status = 'REVOKED'`,
      [grantId],
    );
    const row = rows[0];
    if (!row || !["PENDING", "FAILED", "DEFERRED_UNRESOLVED_PAYMENTS"].includes(row.provider_revocation)) return;
    /* fixed reason codes only: never provider text or credentials */
    const finish = async (outcome: string, reason: string, extra: { errorKind?: string; httpStatus?: number } = {}) => {
      await pool.query("UPDATE app_private.payment_grants SET provider_revocation = $2, updated_at = now() WHERE id = $1", [
        grantId,
        outcome,
      ]);
      log("grant.revocation.result", { authorizationId: grantId, outcome, reason, ...extra });
    };
    if (row.unresolved) {
      await finish("DEFERRED_UNRESOLVED_PAYMENTS", "UNRESOLVED_PAYMENTS");
      return;
    }
    const continuation = await authorities.loadContinuation(pool, grantId);
    if (!continuation) {
      await finish("FAILED", "NO_CONTINUATION");
      return;
    }
    try {
      await provider.cancelGrant(continuation);
      await finish("CONFIRMED", "CANCELLED");
    } catch (error) {
      /* a refusal usually means it is already gone; anything unclear can be retried */
      if (error instanceof ProviderRejectedError) {
        await finish("CONFIRMED", "PROVIDER_REFUSED", error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus });
      }
      else {
        const detail = error instanceof ProviderUnknownError ? error.detail : undefined;
        await finish("FAILED", "UNCLEAR_OR_NETWORK", {
          errorKind: detail?.errorKind ?? "OTHER",
          ...(detail?.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
        });
      }
    }
  }

  /* background pass: retry provider cancellation for locally revoked grants only */
  async function retryPendingRevocations(): Promise<{ checked: number }> {
    const { rows } = await pool.query(
      `SELECT id FROM app_private.payment_grants
        WHERE status = 'REVOKED' AND provider_revocation IN ('PENDING', 'FAILED', 'DEFERRED_UNRESOLVED_PAYMENTS')
        ORDER BY updated_at /* each attempt bumps it, so stuck grants can't starve newer ones */
        LIMIT 20`,
    );
    for (const { id } of rows) {
      /* one bad grant must not stop the rest; it stays retryable */
      await cancelAtProvider(id).catch(() => {});
    }
    return { checked: rows.length };
  }

  return { getGrant, listGrants, revokeGrant, cancelAtProvider, retryPendingRevocations };
}

export type PaymentGrantService = ReturnType<typeof createPaymentGrantService>;
