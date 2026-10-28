import { createPrivateKey } from "node:crypto";

import { createOfflineExactInstruction, createOfflineVoucherInstruction, type OfflineExactSenderInput, type OfflineVoucherSenderInput } from "./offline-sender";

async function main(): Promise<void> {
  if (!(globalThis as Record<symbol, unknown>)[Symbol.for("atomic-commits.offline-network-guard")]) {
    throw new Error("Offline network guard is required.");
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 16384) throw new Error("Offline sender input is too large.");
  }
  const request = JSON.parse(input) as { privateKeyPem?: unknown; purchase?: OfflineExactSenderInput; voucher?: OfflineVoucherSenderInput };
  if (typeof request.privateKeyPem !== "string" || Boolean(request.purchase) === Boolean(request.voucher)) throw new Error("Offline sender input is invalid.");
  const key = createPrivateKey(request.privateKeyPem);
  // Only the signed instruction goes to the private parent pipe; never emit the key.
  process.stdout.write(JSON.stringify(request.voucher
    ? createOfflineVoucherInstruction(request.voucher, key)
    : createOfflineExactInstruction(request.purchase!, key)));
}

void main().catch(() => {
  process.stderr.write("Offline sender could not create the instruction.\n");
  process.exitCode = 1;
});
