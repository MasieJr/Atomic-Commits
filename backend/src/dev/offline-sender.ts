import { randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";

import type { Money } from "../domain/payment-engine/money";
import {
  offlineInstructionSigningBytes,
  parseSignedOfflineInstruction,
  type OfflineInstructionV1,
  type SignedOfflineInstructionV1,
} from "../domain/payment-engine/signed-offline-instruction";

/** Inputs available to the enrolled sender before choosing a merchant. */
export interface OfflineVoucherSenderInput {
  readonly envelopeId: string;
  readonly authorizationId: string;
  readonly deviceId: string;
  readonly keyVersion: string;
  readonly maxPayerDebit: Money;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

/** Optional separate exact-purchase flow when the sender already knows the merchant. */
export interface OfflineExactSenderInput extends OfflineVoucherSenderInput {
  readonly merchantScopeId: string;
  readonly merchantReceive: Money;
}

function signInstruction(input: OfflineVoucherSenderInput, privateKey: KeyObject, purchase?: Pick<OfflineExactSenderInput, "merchantScopeId" | "merchantReceive">): SignedOfflineInstructionV1 {
  if (process.env.NODE_ENV === "production" || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The offline sender requires a development Ed25519 private key.");
  }
  const payload: OfflineInstructionV1 = {
    version: "1",
    envelopeId: input.envelopeId,
    authorizationId: input.authorizationId,
    instructionId: randomUUID(),
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    nonce: randomBytes(16).toString("base64url"),
    issuedAtEpochMs: input.issuedAtEpochMs,
    expiresAtEpochMs: input.expiresAtEpochMs,
    assetCode: input.maxPayerDebit.assetCode,
    assetScale: input.maxPayerDebit.assetScale,
    maxDebitMinor: input.maxPayerDebit.value,
    ...(purchase ? { merchantScopeId: purchase.merchantScopeId, exactPurchase: { merchantReceive: { ...purchase.merchantReceive } } } : {}),
  };
  // Reuse the existing strict parser before signing; the dummy signature is never emitted.
  const parsed = parseSignedOfflineInstruction({ payload, signature: Buffer.alloc(64).toString("base64url") });
  if (!parsed) throw new Error("The offline instruction is malformed.");
  const signature = sign(null, offlineInstructionSigningBytes(parsed.payload), privateKey).toString("base64url");
  return { payload: parsed.payload, signature };
}

/** Development-only sender: signs a ceiling without selecting a merchant. */
export function createOfflineVoucherInstruction(input: OfflineVoucherSenderInput, privateKey: KeyObject): SignedOfflineInstructionV1 {
  return signInstruction(input, privateKey);
}

/** Development-only exact purchase remains available as a separate flow. */
export function createOfflineExactInstruction(input: OfflineExactSenderInput, privateKey: KeyObject): SignedOfflineInstructionV1 {
  return signInstruction(input, privateKey, input);
}
