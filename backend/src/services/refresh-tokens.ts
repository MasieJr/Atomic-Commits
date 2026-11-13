import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/* Refresh tokens are opaque 256-bit random strings stored only as SHA-256
   hashes. Rotation gives every refresh a fresh token; presenting an already
   rotated token means the pair may be stolen, so the whole family is revoked. */
const refreshTokenTtlSeconds = 30 * 24 * 60 * 60;

type Queryable = Pool | PoolClient;

export interface RefreshTokenService {
  issue(userId: number): Promise<string>;
  issueWith(client: Queryable, userId: number): Promise<string>;
  rotate(refreshToken: string): Promise<{ userId: number; token: string } | undefined>;
  revoke(refreshToken: string): Promise<void>;
}

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

async function insert(client: Queryable, userId: number): Promise<string> {
  const token = newToken();
  await client.query(
    `INSERT INTO app_private.refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [userId, hash(token), refreshTokenTtlSeconds],
  );
  return token;
}

export function createRefreshTokenService(pool: Pool): RefreshTokenService {
  async function issue(userId: number): Promise<string> {
    const token = await insert(pool, userId);
    /* opportunistic cleanup keeps the table bounded without a cron job */
    await pool.query(
      `DELETE FROM app_private.refresh_tokens
       WHERE expires_at < now() - interval '7 days'`,
    );
    return token;
  }

  async function issueWith(client: Queryable, userId: number): Promise<string> {
    return insert(client, userId);
  }

  async function rotate(refreshToken: string): Promise<{ userId: number; token: string } | undefined> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{
        id: string;
        user_id: number;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, user_id, revoked_at, expires_at
         FROM app_private.refresh_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [hash(refreshToken)],
      );
      const row = rows.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      if (row.revoked_at) {
        /* reuse of a rotated token: assume theft and kill every session */
        await client.query(
          `UPDATE app_private.refresh_tokens
           SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id],
        );
        await client.query("COMMIT");
        return undefined;
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE app_private.refresh_tokens SET revoked_at = now() WHERE id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        return undefined;
      }

      const token = newToken();
      const replacement = await client.query<{ id: string }>(
        `INSERT INTO app_private.refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         RETURNING id`,
        [row.user_id, hash(token), refreshTokenTtlSeconds],
      );
      const replacementId = replacement.rows[0]?.id;
      if (!replacementId) throw new Error("refresh token insert failed");

      await client.query(
        `UPDATE app_private.refresh_tokens
         SET revoked_at = now(), replaced_by = $2
         WHERE id = $1 AND revoked_at IS NULL`,
        [row.id, replacementId],
      );
      await client.query("COMMIT");
      return { userId: row.user_id, token };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function revoke(refreshToken: string): Promise<void> {
    await pool.query(
      `UPDATE app_private.refresh_tokens
       SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hash(refreshToken)],
    );
  }

  return { issue, issueWith, rotate, revoke };
}
