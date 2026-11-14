import { createHmac, hkdfSync } from "node:crypto";

export function createTotpReplayDigests(dataKeys: ReadonlyMap<number, Buffer>) {
  const keys = new Map([...dataKeys].map(([version, key]) => [
    version, Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "totp-code-replay-guard", 32)),
  ]));
  return (deviceId: string, code: string): Map<number, Buffer> =>
    new Map([...keys].map(([version, key]) => [version, createHmac("sha256", key).update(`${deviceId}:${code}`).digest()]));
}
