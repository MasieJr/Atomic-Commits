import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { isValidTotpSecret } from "../domain/payment-engine/totp";
import { ApiError } from "../errors/api-error";
import { AuthStorageError } from "../errors/auth";
import type { DataEncryption } from "./data-encryption";

/*
 * Server-side TOTP device enrollment. The backend picks the public prefix and
 * the secret; the payer client only consumes the one-time packet. The secret is
 * stored encrypted and is never returned again.
 */

/** Exactly the fields the offline client's strict parser accepts - no extras. */
export interface EnrollmentPacket {
  readonly version: 1;
  readonly prefix: string;
  readonly secret: string;
  readonly algorithm: "SHA1";
  readonly digits: 6;
  readonly periodSeconds: 30;
  readonly expiresAtEpochMs: number;
  readonly revoked: false;
}

export interface DeviceStatus {
  readonly prefix: string;
  readonly deviceName: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly authorizationId: string;
  readonly grantStatus: string;
  readonly expiresAtEpochMs: number;
  readonly createdAt: string;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/* no 0/O/1/I: prefixes are read aloud and typed by people */
const PREFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREFIX_LENGTH = 6;
const SECRET_BYTES = 20; /* 160 bits = the offline client's floor */
const ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PREFIX_ATTEMPTS = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_PATTERN = /^[A-Z0-9]{4,12}$/;

/** RFC 4648 Base32 (uppercase). 20 bytes -> 32 letters, so no padding at all. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function deviceSecretContext(deviceId: string): string {
  return `totp-device-secret:${deviceId}`;
}

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

export interface TotpEnrollmentOptions {
  readonly pool: Pool;
  readonly encryption: DataEncryption;
  readonly now?: () => number;
}

export function createTotpEnrollmentService({ pool, encryption, now = Date.now }: TotpEnrollmentOptions) {
  function newPrefix(): string {
    let prefix = "";
    for (let i = 0; i < PREFIX_LENGTH; i += 1) prefix += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
    return prefix;
  }

  async function enrollDevice(
    userId: number,
    authorizationId: unknown,
    deviceName: unknown,
  ): Promise<EnrollmentPacket> {
    if (typeof authorizationId !== "string" || !UUID_PATTERN.test(authorizationId)) {
      throw new ApiError(400, "authorizationId must be a valid grant id.");
    }
    const name = typeof deviceName === "string" ? deviceName.trim() : "";
    if (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new ApiError(400, "deviceName must be 1 to 60 printable characters.");
    }

    const nowMs = now();
    try {
      /* only the owner's grant is visible: someone else's id looks like "not found" */
      const grants = await pool.query(
        `SELECT status, authority_source, valid_from, valid_until
           FROM app_private.payment_grants
          WHERE id = $1 AND payer_user_id = $2`,
        [authorizationId, userId],
      );
      const grant = grants.rows[0];
      if (!grant) throw new ApiError(404, "Grant not found.");
      if (
        grant.status !== "ACTIVE" ||
        nowMs < new Date(grant.valid_from).getTime() ||
        nowMs >= new Date(grant.valid_until).getTime()
      ) {
        throw new ApiError(409, "This grant is not usable. Authorize a new grant first.");
      }

      const expiresAtMs = Math.min(new Date(grant.valid_until).getTime(), nowMs + ENROLLMENT_TTL_MS);

      for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt += 1) {
        const id = randomUUID();
        const prefix = newPrefix();
        const secret = base32Encode(randomBytes(SECRET_BYTES));
        if (!PREFIX_PATTERN.test(prefix) || !isValidTotpSecret(secret, 20)) {
          throw new Error("Generated enrollment material is malformed.");
        }
        const sealed = encryption.encrypt(secret, deviceSecretContext(id));

        try {
          await pool.query(
            `INSERT INTO app_private.totp_devices
               (id, payer_user_id, authorization_id, device_name, prefix,
                secret_ciphertext, key_version, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))`,
            [id, userId, authorizationId, name, prefix, sealed.ciphertext, sealed.keyVersion, expiresAtMs],
          );
        } catch (error) {
          if (isUniqueViolation(error, "totp_devices_prefix_key")) continue; /* prefix taken: pick another */
          if (isUniqueViolation(error, "totp_devices_one_active_per_grant")) {
            throw new ApiError(
              409,
              "This grant already has an active device. Revoke it before enrolling again.",
            );
          }
          throw error;
        }

        /* only now, after the row is committed, does the secret leave the server */
        return {
          version: 1,
          prefix,
          secret,
          algorithm: "SHA1",
          digits: 6,
          periodSeconds: 30,
          expiresAtEpochMs: expiresAtMs,
          revoked: false,
        };
      }
      throw new ApiError(503, "Could not allocate a device prefix. Please try again.");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new AuthStorageError("Device storage is unavailable.");
    }
  }

  async function getStatus(userId: number, prefix: unknown): Promise<DeviceStatus> {
    if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) throw new ApiError(404, "Device not found.");
    try {
      const { rows } = await pool.query(
        `SELECT d.prefix, d.device_name, d.status, d.authorization_id, d.expires_at, d.created_at,
                g.status AS grant_status
           FROM app_private.totp_devices d
           JOIN app_private.payment_grants g ON g.id = d.authorization_id
          WHERE d.prefix = $1 AND d.payer_user_id = $2`,
        [prefix, userId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, "Device not found.");
      return {
        prefix: row.prefix,
        deviceName: row.device_name,
        status: row.status,
        authorizationId: row.authorization_id,
        grantStatus: row.grant_status,
        expiresAtEpochMs: new Date(row.expires_at).getTime(),
        createdAt: new Date(row.created_at).toISOString(),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new AuthStorageError("Device storage is unavailable.");
    }
  }

  async function revokeDevice(userId: number, prefix: unknown): Promise<DeviceStatus> {
    if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) throw new ApiError(404, "Device not found.");
    try {
      /* revoking twice is fine: the first call changes it, later calls change nothing */
      await pool.query(
        `UPDATE app_private.totp_devices
            SET status = 'REVOKED', revoked_at = now(), revocation_version = revocation_version + 1
          WHERE prefix = $1 AND payer_user_id = $2 AND status = 'ACTIVE'`,
        [prefix, userId],
      );
    } catch {
      throw new AuthStorageError("Device storage is unavailable.");
    }
    return getStatus(userId, prefix);
  }

  return { enrollDevice, getStatus, revokeDevice };
}

export type TotpEnrollmentService = ReturnType<typeof createTotpEnrollmentService>;
