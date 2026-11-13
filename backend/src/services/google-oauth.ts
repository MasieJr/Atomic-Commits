import bcrypt from "bcrypt";
import { ipKeyGenerator } from "express-rate-limit";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../errors/api-error";
import { AuthStorageError } from "../errors/auth";
import type { User } from "../models/users";
import type { DataEncryption } from "./data-encryption";
import type { AccessTokenService } from "./tokens";

export const googleOAuthPath = "/api/auth/google";

// Fixed Google endpoints, never a URL supplied by a request or JWT header.
const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const keysEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const pollIntervalMs = 2_000;
const maxResponseBytes = 64 * 1024;
const maxLinkChecks = 5;
// Same work factor as local registration. Missing/invalid credentials still do bcrypt work.
const dummyPasswordHash = "$2b$12$Ok44cctT7ytcTIK7YDrAoeywTPKihwrWuiToIlsE4SaKNhO9IOyl6";

interface GoogleOAuthOptions {
  pool: Pool;
  encryption: DataEncryption;
  tokens: AccessTokenService;
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
}

type FailureCode = "google_verification_failed" | "processing_timeout" | "link_attempts_exhausted" | "link_conflict";
type TerminalAttemptResult =
  | { status: "cancelled" | "expired" | "consumed" }
  | { status: "failed"; code: FailureCode };
type RateLimitedResult = { status: "rate_limited"; retryAfterSeconds: number };
type AttemptResult =
  | { status: "pending"; pollIntervalMs: number }
  | { status: "link_required"; attemptsRemaining: number; expiresAt: string; expiresInMs: number }
  | { status: "complete"; user: User; token: string }
  | RateLimitedResult
  | TerminalAttemptResult;
type LinkResult =
  | { status: "ready" }
  | { status: "invalid_password"; attemptsRemaining: number }
  | RateLimitedResult
  | TerminalAttemptResult;

type AttemptRow = { id: string; expires_at: Date; expires_in_ms: number; link_checks: number } & (
  | { status: "pending" | "processing"; user_id: null; failure_code: null }
  | {
    status: "link_required" | "linking"; user_id: null; failure_code: null;
    link_subject: string; link_user_id: number; link_check_ready: boolean;
  }
  | { status: "ready"; user_id: number; failure_code: null }
  | { status: "consumed" | "cancelled" | "expired"; user_id: null; failure_code: null }
  | { status: "failed"; user_id: null; failure_code: FailureCode }
);

type LinkReservation =
  | { kind: "reserved"; passwordHash: string | undefined }
  | { kind: "result"; result: LinkResult };

interface ClaimedAttempt {
  id: string;
  nonce_hash: Buffer;
  verifier_ciphertext: Buffer;
  key_version: number;
}

interface GoogleIdentity {
  subject: string;
  email: string;
  name: string;
}

type Callback = { state: string } & (
  | { kind: "code"; code: string }
  | { kind: "error"; cancelled: boolean }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

function parseHandoff(input: unknown): { attemptId: string; pollSecret: string } {
  if (!isRecord(input) || typeof input.attemptId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.attemptId)
    || !isSecret(input.pollSecret)) {
    throw new ApiError(400, "Invalid Google sign-in attempt.", "GOOGLE_ATTEMPT_INVALID");
  }
  return { attemptId: input.attemptId, pollSecret: input.pollSecret };
}

function inactiveLinkResult(attempt: AttemptRow): LinkResult {
  switch (attempt.status) {
    case "ready":
      return { status: "ready" };
    case "cancelled":
    case "expired":
    case "consumed":
      return { status: attempt.status };
    case "failed":
      return { status: "failed", code: attempt.failure_code };
    default:
      throw new ApiError(409, "This attempt is not awaiting account linking.", "GOOGLE_LINK_NOT_READY");
  }
}

function parseCallback(input: unknown): Callback | undefined {
  if (!isRecord(input) || !isSecret(input.state)) return undefined;
  if (input.iss !== undefined && input.iss !== "https://accounts.google.com") return undefined;
  if (typeof input.error === "string" && input.error.length <= 128 && input.code === undefined) {
    return { kind: "error", state: input.state, cancelled: input.error === "access_denied" };
  }
  if (typeof input.code === "string" && input.code.length > 0 && input.code.length <= 8192
    && !/[\x00-\x20\x7f]/.test(input.code) && input.error === undefined) {
    return { kind: "code", state: input.state, code: input.code };
  }
  return undefined;
}

function parseConfiguration(options: GoogleOAuthOptions) {
  let base: URL;
  try {
    base = new URL(options.publicBaseUrl.trim());
  } catch {
    throw new Error("Google sign-in requires an HTTPS PUBLIC_BASE_URL origin.");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Google sign-in requires an HTTPS PUBLIC_BASE_URL origin without a path, query, or credentials.");
  }
  const clientId = options.clientId.trim();
  const clientSecret = options.clientSecret.trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256
    || !clientSecret || clientSecret.length > 4096) {
    throw new Error("Google sign-in requires a Google web client ID and client secret.");
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${base.origin}${googleOAuthPath}/callback`,
    completionUrl: `${base.origin}${googleOAuthPath}/complete`,
  };
}

function verificationFailed(): Error {
  return new Error("Google identity verification failed.");
}

async function googleJson(url: string, init: RequestInit = {}): Promise<{ body: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxResponseBytes) {
    await response.body?.cancel();
    throw verificationFailed();
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw verificationFailed();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { body, headers: response.headers };
}

function decodePart(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw verificationFailed();
  const decoded = Buffer.from(part, "base64url");
  if (decoded.toString("base64url") !== part) throw verificationFailed();
  return decoded;
}

function createGoogleVerifier(clientId: string) {
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let nextRefreshAt = 0;
  let refreshing: Promise<void> | undefined;

  async function refreshKeys(): Promise<void> {
    // Coalesce refreshes and bound unknown-kid traffic. Never use stale keys after failure.
    if (refreshing) return refreshing;
    if (Date.now() < nextRefreshAt) throw verificationFailed();
    nextRefreshAt = Date.now() + 30_000;
    refreshing = (async () => {
      const { body, headers } = await googleJson(keysEndpoint, { headers: { Accept: "application/json" } });
      if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 10) {
        throw verificationFailed();
      }
      const replacement = new Map<string, KeyObject>();
      for (const key of body.keys) {
        if (!isRecord(key) || key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig"
          || typeof key.kid !== "string" || key.kid.length < 1 || key.kid.length > 256
          || typeof key.n !== "string" || typeof key.e !== "string" || replacement.has(key.kid)) {
          throw verificationFailed();
        }
        const modulus = decodePart(key.n);
        const exponent = decodePart(key.e);
        if (modulus.length < 256 || modulus.length > 1024 || exponent.length < 1 || exponent.length > 8) {
          throw verificationFailed();
        }
        const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
        if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw verificationFailed();
        replacement.set(key.kid, publicKey);
      }
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get("cache-control") ?? "");
      const age = Number(headers.get("age") ?? "0");
      const ttl = Math.max(0, Math.min(3600, Number(maxAge?.[1] ?? "300") - (Number.isFinite(age) ? age : 0)));
      keys = replacement;
      expiresAt = Date.now() + ttl * 1000;
    })();
    try {
      await refreshing;
    } finally {
      refreshing = undefined;
    }
  }

  return async (idToken: string, nonceHash: Buffer): Promise<GoogleIdentity> => {
    if (idToken.length > 16_384) throw verificationFailed();
    const parts = idToken.split(".");
    if (parts.length !== 3) throw verificationFailed();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header: unknown = JSON.parse(decodePart(encodedHeader).toString("utf8"));
    if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string"
      || header.kid.length < 1 || header.kid.length > 256 || header.crit !== undefined || header.b64 !== undefined
      || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) {
      throw verificationFailed();
    }
    if (Date.now() >= expiresAt || !keys.has(header.kid)) await refreshKeys();
    const key = keys.get(header.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), key, decodePart(encodedSignature))) {
      throw verificationFailed();
    }
    const claims: unknown = JSON.parse(decodePart(encodedPayload).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!isRecord(claims)
      || (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com")
      // This backend has one web audience; multi-audience/hybrid tokens are not accepted.
      || claims.aud !== clientId || (claims.azp !== undefined && claims.azp !== clientId)
      || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now
      || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60
      || claims.iat <= 0 || claims.exp <= claims.iat
      || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > now))
      || typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)
      || claims.email_verified !== true || typeof claims.email !== "string" || claims.email.length > 254
      || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(claims.email)
      || !isSecret(claims.nonce) || !timingSafeEqual(hash(claims.nonce), nonceHash)) {
      throw verificationFailed();
    }
    const name = typeof claims.name === "string" ? claims.name.trim() : "";
    const validName = Array.from(name).length >= 2 && Array.from(name).length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
    return { subject: claims.sub, email: claims.email.toLowerCase(), name: validName ? name : "Google user" };
  };
}

export function createGoogleOAuthService(options: GoogleOAuthOptions) {
  const { pool, encryption, tokens } = options;
  const configuration = parseConfiguration(options);
  const verifyIdentity = createGoogleVerifier(configuration.clientId);

  async function query<Row extends QueryResultRow>(sql: string, values: unknown[] = []) {
    try {
      return await pool.query<Row>(sql, values);
    } catch {
      throw new AuthStorageError("Google sign-in storage is unavailable.");
    }
  }

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new AuthStorageError("Google sign-in storage is unavailable.");
    } finally {
      client?.release();
    }
  }

  async function expireAttempt(client: PoolClient, attemptId: string): Promise<void> {
    await client.query(
      `UPDATE app_private.google_oauth_attempts
       SET status = CASE WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE 'failed' END,
           failure_code = CASE WHEN expires_at <= statement_timestamp() THEN NULL ELSE 'processing_timeout' END,
           verifier_ciphertext = NULL, key_version = NULL, user_id = NULL, processing_deadline = NULL,
           link_subject = NULL, link_user_id = NULL,
           updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('pending', 'processing', 'link_required', 'linking', 'ready')
         AND (expires_at <= statement_timestamp() OR processing_deadline <= statement_timestamp())`,
      [attemptId],
    );
  }

  async function lockAttempt(client: PoolClient, proof: { attemptId: string; pollSecret: string }): Promise<AttemptRow> {
    const found = await client.query<{ id: string }>(
      "SELECT id FROM app_private.google_oauth_attempts WHERE id = $1 AND poll_secret_hash = $2 FOR UPDATE",
      [proof.attemptId, hash(proof.pollSecret)],
    );
    if (!found.rowCount) throw new ApiError(404, "Google sign-in attempt is unavailable.", "GOOGLE_ATTEMPT_UNAVAILABLE");
    await expireAttempt(client, proof.attemptId);
    const result = await client.query<AttemptRow>(
      `SELECT id, status, user_id, failure_code, expires_at,
         GREATEST(0, floor(extract(epoch FROM (expires_at - clock_timestamp())) * 1000))::integer AS expires_in_ms,
         link_subject, link_user_id, link_checks,
         (link_next_check_at IS NULL OR link_next_check_at <= clock_timestamp()) AS link_check_ready
       FROM app_private.google_oauth_attempts WHERE id = $1`,
      [proof.attemptId],
    );
    return result.rows[0];
  }

  async function takeLinkIpBudget(clientIp: string | undefined): Promise<boolean> {
    if (!clientIp || !isIP(clientIp)) {
      throw new ApiError(503, "Google account linking is unavailable.", "GOOGLE_LINK_UNAVAILABLE");
    }
    // req.ip comes from Express's configured proxy trust, never from the request body.
    // A /56 bucket prevents IPv6 interface-address rotation from bypassing the limit.
    const ipHash = hash(`google-link:${ipKeyGenerator(clientIp, 56)}`);
    const result = await query(
      `INSERT INTO app_private.google_oauth_link_limits AS limits (ip_hash, requests, expires_at)
       VALUES ($1, 1, statement_timestamp() + interval '15 minutes')
       ON CONFLICT (ip_hash) DO UPDATE
       SET requests = CASE WHEN limits.expires_at <= statement_timestamp() THEN 1 ELSE limits.requests + 1 END,
           expires_at = CASE WHEN limits.expires_at <= statement_timestamp()
             THEN statement_timestamp() + interval '15 minutes' ELSE limits.expires_at END
       WHERE limits.expires_at <= statement_timestamp() OR limits.requests < 10
       RETURNING ip_hash`,
      [ipHash],
    );
    return Boolean(result.rowCount);
  }

  async function takeLinkAccountBudget(client: PoolClient, userId: number): Promise<boolean> {
    // Only the verified attempt selects this account. The unique key serializes
    // reservations across attempts, IPs, and processes without locking password login.
    const result = await client.query(
      `INSERT INTO app_private.google_oauth_link_account_limits AS limits (user_id, checks, expires_at)
       VALUES ($1, 1, statement_timestamp() + interval '15 minutes')
       ON CONFLICT (user_id) DO UPDATE
       SET checks = CASE WHEN limits.expires_at <= statement_timestamp() THEN 1 ELSE limits.checks + 1 END,
           expires_at = CASE WHEN limits.expires_at <= statement_timestamp()
             THEN statement_timestamp() + interval '15 minutes' ELSE limits.expires_at END
       WHERE limits.expires_at <= statement_timestamp() OR limits.checks < 10
       RETURNING user_id`,
      [userId],
    );
    return Boolean(result.rowCount);
  }

  async function finishFailure(attemptId: string, status: "cancelled" | "failed", code: FailureCode | null): Promise<void> {
    await query(
      `UPDATE app_private.google_oauth_attempts
       SET status = CASE WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE $2 END,
           failure_code = CASE WHEN expires_at <= statement_timestamp() THEN NULL ELSE $3 END,
           verifier_ciphertext = NULL, key_version = NULL,
           processing_deadline = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'processing'`,
      [attemptId, status, code],
    );
  }

  async function completeAttempt(attemptId: string, identity: GoogleIdentity): Promise<void> {
    // A valid bcrypt hash keeps the existing non-null password schema and login path unchanged.
    // The random 256-bit password is never disclosed or retained.
    const passwordHash = await bcrypt.hash(randomSecret(), 12);
    await transaction(async (client) => {
      const locked = await client.query<{ id: string }>(
        "SELECT id FROM app_private.google_oauth_attempts WHERE id = $1 AND status = 'processing' FOR UPDATE",
        [attemptId],
      );
      if (!locked.rowCount) return;
      await expireAttempt(client, attemptId);
      const active = await client.query<{ id: string }>(
        "SELECT id FROM app_private.google_oauth_attempts WHERE id = $1 AND status = 'processing'",
        [attemptId],
      );
      if (!active.rowCount) return;

      // Serialize only this Google subject. The users.email unique constraint arbitrates
      // races against password signup and against other Google subjects with that email.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`google-oauth:${identity.subject}`]);
      const existing = await client.query<{ user_id: number }>(
        "SELECT user_id FROM app_private.google_oauth_identities WHERE subject = $1",
        [identity.subject],
      );
      let userId = existing.rows[0]?.user_id;
      if (userId === undefined) {
        const created = await client.query<{ id: number }>(
          `INSERT INTO app_private.users (name, email, password_hash) VALUES ($1, $2, $3)
           ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING RETURNING id`,
          [identity.name, identity.email, passwordHash],
        );
        userId = created.rows[0]?.id;
        if (userId === undefined) {
          const collision = await client.query<{ id: number }>(
            "SELECT id FROM app_private.users WHERE email = $1", [identity.email],
          );
          const localUser = collision.rows[0];
          if (!localUser) throw new ApiError(409, "Restart Google sign-in.", "GOOGLE_LINK_NOT_READY");
          const awaitingProof = await client.query(
            `UPDATE app_private.google_oauth_attempts SET status = 'link_required',
               link_subject = $2, link_user_id = $3, verifier_ciphertext = NULL, key_version = NULL,
               processing_deadline = NULL, expires_at = LEAST(expires_at, clock_timestamp() + interval '5 minutes'),
               updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'processing' AND expires_at > clock_timestamp()
               AND processing_deadline > clock_timestamp()`,
            [attemptId, identity.subject, localUser.id],
          );
          if (!awaitingProof.rowCount) throw new ApiError(410, "Google sign-in expired.", "GOOGLE_ATTEMPT_EXPIRED");
          return;
        }
        await client.query(
          "INSERT INTO app_private.google_oauth_identities (subject, user_id) VALUES ($1, $2)",
          [identity.subject, userId],
        );
      }
      const ready = await client.query(
        `UPDATE app_private.google_oauth_attempts SET status = 'ready', user_id = $2,
           verifier_ciphertext = NULL, key_version = NULL, processing_deadline = NULL,
           expires_at = LEAST(expires_at, clock_timestamp() + interval '2 minutes'), updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'processing' AND expires_at > clock_timestamp()
           AND processing_deadline > clock_timestamp()`,
        [attemptId, userId],
      );
      // Roll back any new account if verification finished after the deadline.
      if (!ready.rowCount) throw new ApiError(410, "Google sign-in expired.", "GOOGLE_ATTEMPT_EXPIRED");
    });
  }

  return {
    completionUrl: configuration.completionUrl,

    async start() {
      const attemptId = randomUUID();
      const state = randomSecret();
      const nonce = randomSecret();
      const verifier = randomSecret();
      const pollSecret = randomSecret();
      const encrypted = encryption.encrypt(verifier, `google-oauth:${attemptId}:pkce`);
      const result = await query<{ expires_at: Date; expires_in_ms: number }>(
        `INSERT INTO app_private.google_oauth_attempts
           (id, state_hash, poll_secret_hash, nonce_hash, verifier_ciphertext, key_version, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, statement_timestamp(), statement_timestamp() + interval '10 minutes')
         RETURNING expires_at, GREATEST(0, floor(extract(epoch FROM (expires_at - clock_timestamp())) * 1000))::integer AS expires_in_ms`,
        [attemptId, hash(state), hash(pollSecret), hash(nonce), encrypted.ciphertext, encrypted.keyVersion],
      );
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: configuration.clientId,
        redirect_uri: configuration.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        code_challenge: hash(verifier).toString("base64url"),
        code_challenge_method: "S256",
        state,
        nonce,
        prompt: "select_account",
        access_type: "online",
      }).toString();
      return { attemptId, pollSecret, authorizationUrl: url.toString(), expiresAt: result.rows[0].expires_at.toISOString(), expiresInMs: result.rows[0].expires_in_ms, pollIntervalMs };
    },

    async callback(input: unknown): Promise<void> {
      const callback = parseCallback(input);
      if (!callback) return;
      const claimed = await query<ClaimedAttempt>(
        `UPDATE app_private.google_oauth_attempts
         SET status = 'processing', processing_deadline = LEAST(expires_at, clock_timestamp() + interval '45 seconds'),
             updated_at = clock_timestamp()
         WHERE state_hash = $1 AND status = 'pending' AND expires_at > clock_timestamp()
         RETURNING id, nonce_hash, verifier_ciphertext, key_version`,
        [hash(callback.state)],
      );
      const attempt = claimed.rows[0];
      if (!attempt) return;
      if (callback.kind === "error") {
        await finishFailure(attempt.id, callback.cancelled ? "cancelled" : "failed", callback.cancelled ? null : "google_verification_failed");
        return;
      }
      try {
        const verifier = encryption.decrypt(
          { ciphertext: attempt.verifier_ciphertext, keyVersion: attempt.key_version },
          `google-oauth:${attempt.id}:pkce`,
        );
        const { body } = await googleJson(tokenEndpoint, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: configuration.clientId,
            client_secret: configuration.clientSecret,
            redirect_uri: configuration.redirectUri,
            code: callback.code,
            code_verifier: verifier,
          }).toString(),
        });
        if (!isRecord(body) || typeof body.id_token !== "string") throw verificationFailed();
        const identity = await verifyIdentity(body.id_token, attempt.nonce_hash);
        await completeAttempt(attempt.id, identity);
      } catch {
        // Never echo or log provider bodies, authorization codes, tokens, or database errors.
        // No replay of a claimed code after network failure or an uncertain commit.
        await finishFailure(attempt.id, "failed", "google_verification_failed");
      }
    },

    async consume(input: unknown): Promise<AttemptResult> {
      const proof = parseHandoff(input);
      const { attemptId } = proof;
      return transaction(async (client): Promise<AttemptResult> => {
        const attempt = await lockAttempt(client, proof);
        // Authenticate before charging the attempt, so a wrong secret cannot
        // exhaust its polling allowance. The row lock also covers this budget.
        const allowed = await client.query(
          `UPDATE app_private.google_oauth_attempts
           SET consume_requests = CASE WHEN consume_window_expires_at IS NULL
                 OR consume_window_expires_at <= statement_timestamp() THEN 1 ELSE consume_requests + 1 END,
               consume_window_expires_at = CASE WHEN consume_window_expires_at IS NULL
                 OR consume_window_expires_at <= statement_timestamp()
                 THEN statement_timestamp() + interval '1 minute' ELSE consume_window_expires_at END
           WHERE id = $1 AND (consume_window_expires_at IS NULL
             OR consume_window_expires_at <= statement_timestamp() OR consume_requests < 60)
           RETURNING id`,
          [attemptId],
        );
        if (!allowed.rowCount) return { status: "rate_limited", retryAfterSeconds: 60 };
        switch (attempt.status) {
          case "pending":
          case "processing":
          case "linking":
            return { status: "pending", pollIntervalMs };
          case "link_required":
            return { status: "link_required", attemptsRemaining: maxLinkChecks - attempt.link_checks, expiresAt: attempt.expires_at.toISOString(), expiresInMs: attempt.expires_in_ms };
          case "failed":
            return { status: "failed", code: attempt.failure_code };
          case "cancelled":
          case "expired":
          case "consumed":
            return { status: attempt.status };
          case "ready": {
            const users = await client.query<User>("SELECT id, name, email FROM app_private.users WHERE id = $1", [attempt.user_id]);
            const user = users.rows[0];
            if (!user) throw new ApiError(404, "Google sign-in attempt is unavailable.", "GOOGLE_ATTEMPT_UNAVAILABLE");
            const token = tokens.sign(user.id);
            const consumed = await client.query(
              `UPDATE app_private.google_oauth_attempts SET status = 'consumed', user_id = NULL, updated_at = clock_timestamp()
               WHERE id = $1 AND status = 'ready' AND expires_at > clock_timestamp()`,
              [attemptId],
            );
            if (!consumed.rowCount) {
              await expireAttempt(client, attemptId);
              return { status: "expired" };
            }
            return { status: "complete", user, token };
          }
          default: {
            const unreachable: never = attempt;
            throw new Error(`Invalid Google attempt: ${typeof unreachable}`);
          }
        }
      });
    },

    async link(input: unknown, clientIp: string | undefined): Promise<LinkResult> {
      // This autocommit budget survives bad proofs, transaction rollback, and process restarts.
      if (!await takeLinkIpBudget(clientIp)) return { status: "rate_limited", retryAfterSeconds: 900 };
      const proof = parseHandoff(input);
      if (!isRecord(input) || input.confirmLink !== true) {
        throw new ApiError(400, "Confirm that you want to connect Google to your existing account.", "GOOGLE_LINK_CONFIRMATION_REQUIRED");
      }
      const password = typeof input.password === "string" && input.password.length >= 8
        && Buffer.byteLength(input.password, "utf8") <= 72 ? input.password : undefined;

      const reservation = await transaction(async (client): Promise<LinkReservation> => {
        const attempt = await lockAttempt(client, proof);
        if (attempt.status === "linking") {
          return { kind: "result", result: { status: "rate_limited", retryAfterSeconds: 2 } };
        }
        if (attempt.status !== "link_required") return { kind: "result", result: inactiveLinkResult(attempt) };
        if (!attempt.link_check_ready) {
          return { kind: "result", result: { status: "rate_limited", retryAfterSeconds: 2 } };
        }
        if (!await takeLinkAccountBudget(client, attempt.link_user_id)) {
          return { kind: "result", result: { status: "rate_limited", retryAfterSeconds: 900 } };
        }
        const reserved = await client.query(
          `UPDATE app_private.google_oauth_attempts SET status = 'linking', link_checks = link_checks + 1,
             link_next_check_at = clock_timestamp() + interval '2 seconds',
             processing_deadline = LEAST(expires_at, clock_timestamp() + interval '45 seconds'), updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'link_required' AND expires_at > clock_timestamp() AND link_checks < $2
             AND (link_next_check_at IS NULL OR link_next_check_at <= clock_timestamp())`,
          [proof.attemptId, maxLinkChecks],
        );
        if (!reserved.rowCount) return { kind: "result", result: { status: "rate_limited", retryAfterSeconds: 2 } };
        const credentials = await client.query<{ password_hash: string }>(
          "SELECT password_hash FROM app_private.users WHERE id = $1", [attempt.link_user_id],
        );
        return { kind: "reserved", passwordHash: credentials.rows[0]?.password_hash };
      });
      if (reservation.kind === "result") return reservation.result;

      // Both the account and attempt reservations have committed. Cancellation,
      // crashes, or a failed finalization cannot refund a password comparison.
      // No database lock is held during bcrypt. Invalid/missing passwords or unusable
      // stored credentials take the cost-12 dummy path, and can never authorize a link.
      const usableHash = typeof reservation.passwordHash === "string"
        && /^\$2[ab]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(reservation.passwordHash);
      const checkedHash = usableHash && password !== undefined ? reservation.passwordHash : undefined;
      const passwordMatches = await bcrypt.compare(password ?? "invalid-link-password", checkedHash ?? dummyPasswordHash);

      return transaction(async (client): Promise<LinkResult> => {
        const attempt = await lockAttempt(client, proof);
        if (attempt.status !== "linking") return inactiveLinkResult(attempt);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`google-oauth:${attempt.link_subject}`]);
        const current = await client.query<{ password_hash: string }>(
          "SELECT password_hash FROM app_private.users WHERE id = $1 FOR UPDATE", [attempt.link_user_id],
        );
        // A password changed while bcrypt was running is not current ownership proof.
        // Hold the user lock until the mapping and readiness commit together.
        if (!passwordMatches || checkedHash === undefined || current.rows[0]?.password_hash !== checkedHash) {
          const exhausted = attempt.link_checks >= maxLinkChecks;
          const failed = await client.query(
            `UPDATE app_private.google_oauth_attempts SET status = $2, failure_code = $3,
               link_subject = CASE WHEN $2 = 'failed' THEN NULL ELSE link_subject END,
               link_user_id = CASE WHEN $2 = 'failed' THEN NULL ELSE link_user_id END,
               processing_deadline = NULL, updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'linking' AND expires_at > clock_timestamp()
               AND processing_deadline > clock_timestamp()`,
            [proof.attemptId, exhausted ? "failed" : "link_required", exhausted ? "link_attempts_exhausted" : null],
          );
          if (!failed.rowCount) return inactiveLinkResult(await lockAttempt(client, proof));
          return exhausted ? { status: "failed", code: "link_attempts_exhausted" }
            : { status: "invalid_password", attemptsRemaining: maxLinkChecks - attempt.link_checks };
        }

        await client.query(
          "INSERT INTO app_private.google_oauth_identities (subject, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [attempt.link_subject, attempt.link_user_id],
        );
        const mapping = await client.query<{ user_id: number }>(
          "SELECT user_id FROM app_private.google_oauth_identities WHERE subject = $1 AND user_id = $2",
          [attempt.link_subject, attempt.link_user_id],
        );
        if (!mapping.rowCount) {
          await client.query(
            `UPDATE app_private.google_oauth_attempts SET status = 'failed', failure_code = 'link_conflict',
               link_subject = NULL, link_user_id = NULL, processing_deadline = NULL, updated_at = clock_timestamp()
             WHERE id = $1`, [proof.attemptId],
          );
          return { status: "failed", code: "link_conflict" };
        }
        const ready = await client.query(
          `UPDATE app_private.google_oauth_attempts SET status = 'ready', user_id = $2,
             link_subject = NULL, link_user_id = NULL, processing_deadline = NULL,
             expires_at = LEAST(expires_at, clock_timestamp() + interval '2 minutes'), updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'linking' AND expires_at > clock_timestamp()
             AND processing_deadline > clock_timestamp()`,
          [proof.attemptId, attempt.link_user_id],
        );
        // Roll back a new mapping if its password proof missed either deadline.
        if (!ready.rowCount) throw new ApiError(410, "Google sign-in expired.", "GOOGLE_ATTEMPT_EXPIRED");
        return { status: "ready" };
      });
    },

    async cancel(input: unknown): Promise<{ status: "cancelled" | "consumed" | "expired" | "failed" }> {
      const proof = parseHandoff(input);
      const { attemptId } = proof;
      return transaction(async (client) => {
        await lockAttempt(client, proof);
        await client.query(
          `UPDATE app_private.google_oauth_attempts SET status = 'cancelled', verifier_ciphertext = NULL,
             key_version = NULL, processing_deadline = NULL, user_id = NULL,
             link_subject = NULL, link_user_id = NULL, updated_at = clock_timestamp()
           WHERE id = $1 AND status IN ('pending', 'processing', 'link_required', 'linking', 'ready')`,
          [attemptId],
        );
        const result = await client.query<{ status: "cancelled" | "consumed" | "expired" | "failed" }>(
          "SELECT status FROM app_private.google_oauth_attempts WHERE id = $1", [attemptId],
        );
        return result.rows[0];
      });
    },

    // Run periodically from the host. Deadlines are also enforced without this cleanup.
    async pruneAttempts(): Promise<void> {
      await query(
        `WITH stale AS (
           SELECT id FROM app_private.google_oauth_attempts
           WHERE status IN ('pending', 'processing', 'link_required', 'linking', 'ready')
             AND (expires_at <= statement_timestamp() OR processing_deadline <= statement_timestamp())
           ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
         )
         UPDATE app_private.google_oauth_attempts AS attempt
         SET status = CASE WHEN attempt.expires_at <= statement_timestamp() THEN 'expired' ELSE 'failed' END,
             failure_code = CASE WHEN attempt.expires_at <= statement_timestamp() THEN NULL ELSE 'processing_timeout' END,
             verifier_ciphertext = NULL, key_version = NULL, user_id = NULL, processing_deadline = NULL,
             link_subject = NULL, link_user_id = NULL,
             updated_at = clock_timestamp()
         FROM stale WHERE attempt.id = stale.id`,
      );
      await query(
        `DELETE FROM app_private.google_oauth_attempts WHERE id IN (
           SELECT id FROM app_private.google_oauth_attempts WHERE expires_at < clock_timestamp() - interval '1 day'
           ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
        )`,
      );
      await query(
        `DELETE FROM app_private.google_oauth_link_limits WHERE ip_hash IN (
           SELECT ip_hash FROM app_private.google_oauth_link_limits WHERE expires_at <= statement_timestamp()
           ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
        )`,
      );
      await query(
        `DELETE FROM app_private.google_oauth_link_account_limits WHERE user_id IN (
           SELECT user_id FROM app_private.google_oauth_link_account_limits WHERE expires_at <= statement_timestamp()
           ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
         )`,
      );
    },
  };
}

export type GoogleOAuthService = ReturnType<typeof createGoogleOAuthService>;
