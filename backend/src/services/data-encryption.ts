import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets stored at rest (TOTP seeds, provider
 * tokens). The key is a dedicated DATA_ENCRYPTION_KEY, never JWT_SECRET.
 *
 * Stored blob layout: iv (12 bytes) | auth tag (16 bytes) | ciphertext.
 * `context` is bound as AAD, so a ciphertext copied to another row or purpose
 * fails to decrypt. The key version lives in its own DB column so keys can be
 * rotated later.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedValue {
  readonly ciphertext: Buffer;
  readonly keyVersion: number;
}

export interface DataEncryption {
  encrypt(plaintext: string, context: string): EncryptedValue;
  decrypt(value: EncryptedValue, context: string): string;
}

export class DataEncryptionError extends Error {}

/** Parse a base64 32-byte key; throws a generic error without echoing the key. */
export function parseEncryptionKey(base64Key: string | undefined): Buffer {
  const key = base64Key ? Buffer.from(base64Key.trim(), "base64") : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new DataEncryptionError(
      "DATA_ENCRYPTION_KEY must be 32 random bytes encoded as base64.",
    );
  }
  return key;
}

export function createDataEncryption(
  keys: ReadonlyMap<number, Buffer>,
  currentVersion: number,
): DataEncryption {
  const current = keys.get(currentVersion);
  if (!current || current.length !== KEY_BYTES) {
    throw new DataEncryptionError("Current encryption key is missing or invalid.");
  }

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
        keyVersion: currentVersion,
      };
    },

    decrypt(value, context) {
      const key = keys.get(value.keyVersion);
      if (!key || value.ciphertext.length < IV_BYTES + TAG_BYTES) {
        throw new DataEncryptionError("Stored secret could not be decrypted.");
      }
      try {
        const iv = value.ciphertext.subarray(0, IV_BYTES);
        const tag = value.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const body = value.ciphertext.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        // Generic on purpose: never reveal why decryption failed.
        throw new DataEncryptionError("Stored secret could not be decrypted.");
      }
    },
  };
}

/** Build the service from the environment: one current key, version 1. */
export function createDataEncryptionFromEnv(
  env: Record<string, string | undefined> = process.env,
): DataEncryption {
  return createDataEncryption(new Map([[1, parseEncryptionKey(env.DATA_ENCRYPTION_KEY)]]), 1);
}
