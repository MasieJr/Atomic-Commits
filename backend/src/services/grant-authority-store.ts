import type { Pool, PoolClient } from "pg";

import type { DataEncryption } from "./data-encryption";
import type { OutgoingAuthority } from "./redemption-provider";

/*
 * Encrypted storage for a grant's provider credentials. Tokens only ever exist
 * in plaintext in memory for the duration of a provider call.
 */

type Queryable = Pool | PoolClient;

export interface ContinuationCredential {
  readonly uri: string;
  readonly accessToken: string;
}

function context(grantId: string, kind: string): string {
  return `provider-credential:${grantId}:${kind}`;
}

export function createGrantAuthorityStore(encryption: DataEncryption) {
  async function save(
    db: Queryable,
    grantId: string,
    kind: "ACCESS_TOKEN" | "CONTINUATION",
    payload: unknown,
  ): Promise<void> {
    const sealed = encryption.encrypt(JSON.stringify(payload), context(grantId, kind));
    await db.query(
      `INSERT INTO app_private.provider_credentials (grant_id, kind, ciphertext, key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (grant_id, kind)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version, created_at = now()`,
      [grantId, kind, sealed.ciphertext, sealed.keyVersion],
    );
  }

  async function load(db: Queryable, grantId: string, kind: "ACCESS_TOKEN" | "CONTINUATION"): Promise<unknown> {
    const { rows } = await db.query(
      "SELECT ciphertext, key_version FROM app_private.provider_credentials WHERE grant_id = $1 AND kind = $2",
      [grantId, kind],
    );
    if (!rows[0]) return undefined;
    return JSON.parse(
      encryption.decrypt({ ciphertext: rows[0].ciphertext, keyVersion: rows[0].key_version }, context(grantId, kind)),
    );
  }

  return {
    saveAuthority: (db: Queryable, grantId: string, authority: OutgoingAuthority) =>
      save(db, grantId, "ACCESS_TOKEN", authority),
    saveContinuation: (db: Queryable, grantId: string, continuation: ContinuationCredential) =>
      save(db, grantId, "CONTINUATION", continuation),
    async loadContinuation(db: Queryable, grantId: string): Promise<ContinuationCredential | undefined> {
      const value = (await load(db, grantId, "CONTINUATION")) as ContinuationCredential | undefined;
      if (!value || typeof value.uri !== "string" || typeof value.accessToken !== "string") return undefined;
      return value;
    },
    async loadAuthority(db: Queryable, grantId: string): Promise<OutgoingAuthority | undefined> {
      const value = (await load(db, grantId, "ACCESS_TOKEN")) as OutgoingAuthority | undefined;
      if (!value || typeof value.accessToken !== "string" || value.accessToken.length === 0) return undefined;
      return value;
    },
  };
}

export type GrantAuthorityStore = ReturnType<typeof createGrantAuthorityStore>;
