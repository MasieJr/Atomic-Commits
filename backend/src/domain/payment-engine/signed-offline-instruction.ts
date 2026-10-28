import { createPublicKey, verify } from "node:crypto";

import { isValidMoney, type Money } from "./money";
import { canonicalize, canonicalUtf8Bytes, type CanonicalLeaf } from "./serialization";

/** Present only for an exact purchase; older unbound Errand vouchers remain distinct. */
export interface ExactPurchaseBinding {
  readonly merchantReceive: Money;
}

/** Versioned device-created instruction; provider credentials never appear here. */
export interface OfflineInstructionV1 {
  readonly version: "1";
  readonly envelopeId: string;
  readonly authorizationId: string;
  readonly instructionId: string;
  readonly deviceId: string;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly assetCode: string;
  readonly assetScale: number;
  readonly maxDebitMinor: string;
  readonly merchantScopeId?: string;
  readonly exactPurchase?: ExactPurchaseBinding;
}

export interface SignedOfflineInstructionV1 {
  readonly payload: OfflineInstructionV1;
  /** Unpadded base64url Ed25519 signature; the trusted public key is never supplied by the QR. */
  readonly signature: string;
}

const REQUIRED_FIELDS = [
  "version", "envelopeId", "authorizationId", "instructionId", "deviceId", "keyVersion",
  "nonce", "issuedAtEpochMs", "expiresAtEpochMs", "assetCode", "assetScale", "maxDebitMinor",
] as const;
const OPTIONAL_FIELDS = ["merchantScopeId", "exactPurchase"] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value: unknown): value is string {
  // ASCII prevents cross-platform Unicode-normalization and JSON-escaping ambiguity.
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

function canonicalBase64url(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length >= minimum && bytes.length <= maximum && bytes.toString("base64url") === value;
}

function parseExactPurchase(value: unknown): ExactPurchaseBinding | undefined {
  if (!plainObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "merchantReceive")) return undefined;
  const amount = value.merchantReceive;
  if (!plainObject(amount) || Object.keys(amount).length !== 3 ||
    !Object.hasOwn(amount, "value") || !Object.hasOwn(amount, "assetCode") || !Object.hasOwn(amount, "assetScale") ||
    !isValidMoney(amount) || amount.value === "0" || amount.value.length > 18 || !identifier(amount.assetCode)) return undefined;
  return { merchantReceive: { value: amount.value, assetCode: amount.assetCode, assetScale: amount.assetScale } };
}

/** Strictly parse and copy an untrusted instruction; unknown fields are rejected. */
export function parseSignedOfflineInstruction(value: unknown): SignedOfflineInstructionV1 | undefined {
  try {
    return parseInstruction(value);
  } catch {
    return undefined;
  }
}

function parseInstruction(value: unknown): SignedOfflineInstructionV1 | undefined {
  if (!plainObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "payload") || !Object.hasOwn(value, "signature")) return undefined;
  const body = value.payload;
  if (!plainObject(body) || !canonicalBase64url(value.signature, 64, 64)) return undefined;
  const allowed: readonly string[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || REQUIRED_FIELDS.some((key) => !Object.hasOwn(body, key))) return undefined;
  const hasExactPurchase = Object.hasOwn(body, "exactPurchase");
  const exactPurchase = hasExactPurchase ? parseExactPurchase(body.exactPurchase) : undefined;
  if (
    body.version !== "1" || !identifier(body.envelopeId) || !identifier(body.authorizationId) ||
    !identifier(body.instructionId) || !identifier(body.deviceId) || !identifier(body.keyVersion) ||
    !canonicalBase64url(body.nonce, 16, 32) || !identifier(body.assetCode) ||
    typeof body.assetScale !== "number" || !Number.isInteger(body.assetScale) || body.assetScale < 0 || body.assetScale > 255 ||
    typeof body.issuedAtEpochMs !== "number" || !Number.isSafeInteger(body.issuedAtEpochMs) || body.issuedAtEpochMs < 0 ||
    typeof body.expiresAtEpochMs !== "number" || !Number.isSafeInteger(body.expiresAtEpochMs) || body.expiresAtEpochMs <= body.issuedAtEpochMs ||
    typeof body.maxDebitMinor !== "string" || !/^[1-9][0-9]{0,17}$/.test(body.maxDebitMinor) ||
    (Object.hasOwn(body, "merchantScopeId") && !identifier(body.merchantScopeId)) ||
    (hasExactPurchase && (!exactPurchase || !Object.hasOwn(body, "merchantScopeId")))
  ) return undefined;
  return {
    payload: {
      version: "1",
      envelopeId: body.envelopeId,
      authorizationId: body.authorizationId,
      instructionId: body.instructionId,
      deviceId: body.deviceId,
      keyVersion: body.keyVersion,
      nonce: body.nonce,
      issuedAtEpochMs: body.issuedAtEpochMs,
      expiresAtEpochMs: body.expiresAtEpochMs,
      assetCode: body.assetCode,
      assetScale: body.assetScale,
      maxDebitMinor: body.maxDebitMinor,
      ...(Object.hasOwn(body, "merchantScopeId") && typeof body.merchantScopeId === "string" ? { merchantScopeId: body.merchantScopeId } : {}),
      ...(exactPurchase ? { exactPurchase } : {}),
    },
    signature: value.signature,
  };
}

/** Exact UTF-8 bytes for offline signing; signature itself is excluded. */
export function offlineInstructionSigningBytes(payload: OfflineInstructionV1): Uint8Array {
  const body: Record<string, CanonicalLeaf> = {
    purpose: "atomic-commits/offline-payment",
    version: payload.version,
    envelopeId: payload.envelopeId,
    authorizationId: payload.authorizationId,
    instructionId: payload.instructionId,
    deviceId: payload.deviceId,
    keyVersion: payload.keyVersion,
    nonce: payload.nonce,
    issuedAtEpochMs: payload.issuedAtEpochMs,
    expiresAtEpochMs: payload.expiresAtEpochMs,
    assetCode: payload.assetCode,
    assetScale: payload.assetScale,
    maxDebitMinor: payload.maxDebitMinor,
    ...(payload.merchantScopeId === undefined ? {} : { merchantScopeId: payload.merchantScopeId }),
    ...(payload.exactPurchase === undefined ? {} : { exactPurchase: {
      merchantReceive: {
        value: payload.exactPurchase.merchantReceive.value,
        assetCode: payload.exactPurchase.merchantReceive.assetCode,
        assetScale: payload.exactPurchase.merchantReceive.assetScale,
      },
    } }),
  };
  return canonicalUtf8Bytes(canonicalize({ version: "1", body }));
}

/** Verify using the 32-byte public key from the trusted device registry. */
export function verifyOfflineInstructionSignature(instruction: SignedOfflineInstructionV1, trustedPublicKey: string): boolean {
  const parsed = parseSignedOfflineInstruction(instruction);
  if (!parsed || !canonicalBase64url(trustedPublicKey, 32, 32)) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: trustedPublicKey }, format: "jwk" });
    return verify(null, offlineInstructionSigningBytes(parsed.payload), key, Buffer.from(parsed.signature, "base64url"));
  } catch {
    return false;
  }
}
