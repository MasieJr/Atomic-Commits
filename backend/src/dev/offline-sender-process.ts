import { execFileSync } from "node:child_process";
import { createPublicKey, type KeyObject } from "node:crypto";
import { resolve } from "node:path";

import { parseSignedOfflineInstruction, verifyOfflineInstructionSignature, type SignedOfflineInstructionV1 } from "../domain/payment-engine/signed-offline-instruction";
import { sameAsset } from "../domain/payment-engine/money";
import type { OfflineExactSenderInput, OfflineVoucherSenderInput } from "./offline-sender";

/** Launch the sender in a separate Node process with ordinary network APIs disabled. */
export function runOfflineSender(input: OfflineExactSenderInput, privateKey: KeyObject): SignedOfflineInstructionV1 {
  return runSender(input, privateKey, "purchase");
}

/** Create an unbound ceiling voucher in the same network-disabled sender. */
export function runOfflineVoucherSender(input: OfflineVoucherSenderInput, privateKey: KeyObject): SignedOfflineInstructionV1 {
  return runSender(input, privateKey, "voucher");
}

function runSender(input: OfflineVoucherSenderInput | OfflineExactSenderInput, privateKey: KeyObject, mode: "purchase" | "voucher"): SignedOfflineInstructionV1 {
  if (process.env.NODE_ENV === "production") throw new Error("The offline sender simulator is development-only.");
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (typeof publicKey !== "string") throw new Error("The simulator key is not an Ed25519 key.");
  const root = process.cwd(); // invoke from backend/, as with the existing proof commands
  const guard = resolve(root, "dist/src/dev/offline-network-guard.js");
  const child = resolve(root, "dist/src/dev/offline-sender-child.js");
  let output: string;
  try {
    output = execFileSync(process.execPath, ["--require", guard, child], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", NODE_ENV: "development" },
      input: JSON.stringify({ privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }), [mode]: input }),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("The network-disabled sender could not create the instruction.");
  }
  let parsed: SignedOfflineInstructionV1 | undefined;
  try { parsed = parseSignedOfflineInstruction(JSON.parse(output)); } catch { /* invalid child output */ }
  if (!parsed || !verifyOfflineInstructionSignature(parsed, publicKey)) throw new Error("The offline sender returned an invalid instruction.");
  const payload = parsed.payload;
  if (payload.envelopeId !== input.envelopeId || payload.authorizationId !== input.authorizationId || payload.deviceId !== input.deviceId ||
    payload.keyVersion !== input.keyVersion || payload.issuedAtEpochMs !== input.issuedAtEpochMs || payload.expiresAtEpochMs !== input.expiresAtEpochMs ||
    payload.maxDebitMinor !== input.maxPayerDebit.value || payload.assetCode !== input.maxPayerDebit.assetCode || payload.assetScale !== input.maxPayerDebit.assetScale) {
    throw new Error("The offline sender changed the requested authorization.");
  }
  if (mode === "voucher" && (payload.merchantScopeId !== undefined || payload.exactPurchase !== undefined)) {
    throw new Error("The ceiling voucher must not bind a merchant or exact purchase.");
  }
  if (mode === "purchase") {
    const expected = input as OfflineExactSenderInput;
    const actual = payload.exactPurchase?.merchantReceive;
    if (payload.merchantScopeId !== expected.merchantScopeId || !actual || !sameAsset(actual, expected.merchantReceive) || actual.value !== expected.merchantReceive.value) {
      throw new Error("The offline sender changed the requested purchase.");
    }
  }
  return parsed;
}
