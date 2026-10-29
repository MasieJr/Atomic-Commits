#!/usr/bin/env node
/**
 * `atomic` - offline payer-side demo CLI.
 *
 * Commands:
 *   atomic setup                  Create a protected local device if needed.
 *   atomic enroll --file <path>   Import a trusted, one-time enrollment packet.
 *   atomic pay                    Print the current XXXX-XXXXXX credential.
 *   atomic status                 Print locally stored enrollment facts.
 *
 * `pay` and `status` are STRICTLY LOCAL: no network access, no provider or
 * Open Payments resources, no credentials, no database. `pay` computes an
 * time-based HMAC-SHA1 code (six base36 characters, 30-second step) from
 * the locally enrolled secret. The encoding is not standard decimal TOTP.
 *
 * NON-DISCLOSURE: the TOTP secret is never read from, or written to, command
 * arguments, the environment, stdout/stderr, or logs. It lives only inside
 * the protected local profile file. Error messages are constant and
 * data-free; anything unclassifiable is reported without detail.
 *
 * HONESTY CONTRACT: `status` never claims wallet balance or current
 * provider/grant validity; `pay` states plainly that the displayed code is a
 * short-lived credential, not a payment, a receipt, or proof of purchase.
 * TOTP does not bind an amount, a merchant, or consent; ceilings and one-use
 * are enforced by the backend, not here.
 */

import {
  AtomicStoreError,
  assertProfileUsable,
  deviceProfilePath,
  isProfileExpired,
  isMissingProfileError,
  loadDeviceProfile,
  parseEnrollmentPacket,
  prepareExistingDeviceProfile,
  resolveDeviceHome,
  saveDeviceProfile,
  type DeviceProfile,
} from "../cli/local-device-store";
import { formatPaymentCode, generateTotp } from "../domain/payment-engine/totp";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

const USAGE = `Usage:
  atomic setup                  Create a protected local device if needed.
  atomic enroll --file <path>   Import a trusted, one-time enrollment packet.
  atomic pay                    Print the current XXXX-XXXXXX credential.
  atomic status                 Print locally stored enrollment facts.`;

const ENROLL_DISCLAIMER =
  "The packet file still contains the device secret; delete it now once enrollment succeeds.";
const PAY_DISCLAIMER =
  "This is a short-lived credential only. It is not a payment, not a receipt, and not proof of a successful purchase.";
const STATUS_NOT_ENROLLED =
  "Not enrolled. Run 'atomic enroll --file <packet path>' to provision the demo device shape first.";
const STATUS_DISCLAIMER =
  "This status shows locally stored enrollment facts only. It does not show wallet balance, provider grant validity, or any current payment authorization.";
const GENERIC_FAILURE = "Failed, and detail is suppressed for safety.";
const LOCAL_DEVICE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PREFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** I/O boundary for the CLI so the command logic stays pluggable. */
export type AtomicIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => number;
  readonly env: Record<string, string | undefined>;
};

/** Errors whose message is intentionally user-visible and data-free. */
class AtomicCliError extends Error {}

function readEnrollmentPacketFile(packetPath: string): string {
  try {
    return readFileSync(packetPath, "utf8");
  } catch {
    throw new AtomicCliError("Could not read the enrollment packet file.");
  }
}

function parseEnrollArgs(rest: readonly string[]): string {
  let packetPath: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--file") {
      if (packetPath !== undefined) {
        throw new AtomicCliError("Pass --file exactly once.");
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--") || value.length === 0) {
        throw new AtomicCliError("Pass --file with a packet path.");
      }
      packetPath = value;
      index += 1;
    } else if (arg.startsWith("--file=")) {
      if (packetPath !== undefined) {
        throw new AtomicCliError("Pass --file exactly once.");
      }
      const value = arg.slice("--file=".length);
      if (value.length === 0) {
        throw new AtomicCliError("Pass --file with a packet path.");
      }
      packetPath = value;
    } else {
      throw new AtomicCliError(USAGE);
    }
  }
  if (packetPath === undefined) {
    throw new AtomicCliError(USAGE);
  }
  return packetPath;
}

/** Every character has five uniformly random bits; 32 characters encode 20 bytes. */
function randomBase32(length: number): string {
  return Array.from(randomBytes(length), (byte) => BASE32_ALPHABET[byte & 31]).join("");
}

function randomPrefix(): string {
  return Array.from({ length: 4 }, () => PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)]).join("");
}

/** Create or reuse a protected profile; safely upgrade valid legacy profiles. */
function runSetup(io: AtomicIo): number {
  const home = resolveDeviceHome(io.env);
  try {
    const { profile, upgraded } = prepareExistingDeviceProfile(home, io.now());
    io.stdout(upgraded ? "Updated the local device to the four-by-six code format." : "Local device is already set up.");
    io.stdout(`Prefix: ${profile.prefix}`);
    io.stdout(`Device profile: ${deviceProfilePath(home)}`);
    if (upgraded) io.stdout("The backend must register the updated prefix and code format before redemption.");
    return 0;
  } catch (err) {
    if (!isMissingProfileError(err)) throw err;
  }

  const now = io.now();
  const expiresAtEpochMs = now + LOCAL_DEVICE_LIFETIME_MS;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAtEpochMs) ||
    !Number.isFinite(new Date(expiresAtEpochMs).getTime())) {
    throw new AtomicCliError("The device clock is invalid; fix it before setup.");
  }
  const profile: DeviceProfile = {
    version: 2,
    prefix: randomPrefix(),
    secret: randomBase32(32),
    algorithm: "SHA1",
    codeEncoding: "BASE36-HOTP31",
    codeLength: 6,
    periodSeconds: 30,
    expiresAtEpochMs,
    revoked: false,
  };
  const { profilePath } = saveDeviceProfile(home, profile);
  io.stdout("Created a protected local device profile.");
  io.stdout(`Prefix: ${profile.prefix}`);
  io.stdout(`Local enrollment expires at: ${formatEpochMs(expiresAtEpochMs)} (local data only).`);
  io.stdout(`Device profile: ${profilePath}`);
  io.stdout("The backend must register this device before a merchant can redeem its codes.");
  return 0;
}

function runEnroll(rest: readonly string[], io: AtomicIo): number {
  const packetPath = parseEnrollArgs(rest);
  const text = readEnrollmentPacketFile(packetPath);
  const profile = parseEnrollmentPacket(text, io.now());
  const home = resolveDeviceHome(io.env);
  const { profilePath } = saveDeviceProfile(home, profile);
  io.stdout("Enrolled the offline payment device.");
  io.stdout(`Prefix: ${profile.prefix}`);
  io.stdout(`Local enrollment expires at: ${formatEpochMs(profile.expiresAtEpochMs)} (local data only).`);
  io.stdout(`Device profile: ${profilePath}`);
  io.stdout(ENROLL_DISCLAIMER);
  return 0;
}

function runPay(io: AtomicIo): number {
  const home = resolveDeviceHome(io.env);
  const profile = loadDeviceProfile(home, io.now());
  const nowEpochMs = io.now();
  assertProfileUsable(profile, nowEpochMs);
  const generation = generateTotp(profile.secret, nowEpochMs);
  const presented = formatPaymentCode(profile.prefix, generation.code);
  io.stdout(presented);
  io.stdout(`Code expires at: ${formatEpochMs(Math.min(generation.expiresAtEpochMs, profile.expiresAtEpochMs))} (device-local clock).`);
  io.stdout(PAY_DISCLAIMER);
  return 0;
}

function runStatus(io: AtomicIo): number {
  const home = resolveDeviceHome(io.env);
  let loaded: ReturnType<typeof loadDeviceProfile>;
  try {
    loaded = loadDeviceProfile(home, io.now());
  } catch (err) {
    if (isMissingProfileError(err)) {
      io.stdout(STATUS_NOT_ENROLLED);
      io.stdout(STATUS_DISCLAIMER);
      return 0;
    }
    throw err;
  }
  if (loaded.revoked !== false) {
    // Unreachable through validateDeviceProfile; kept as an explicit
    // fail-closed branch so a locally known revoked state can never be
    // presented as an active device.
    throw new AtomicStoreError("The local device profile is marked revoked.");
  }
  io.stdout("Enrolled (locally stored data).");
  io.stdout(`Prefix: ${loaded.prefix}`);
  io.stdout(`Local enrollment expires at: ${formatEpochMs(loaded.expiresAtEpochMs)} (local data only).`);
  io.stdout(`Device profile: ${deviceProfilePath(home)}`);
  if (isProfileExpired(loaded, io.now())) {
    io.stdout("The locally stored expiry has already passed.");
  }
  io.stdout(STATUS_DISCLAIMER);
  return 0;
}

/** Millisecond timestamps print as UTC ISO, never as secret-adjacent data. */
function formatEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Runs one command; returns the process exit code. All failures are
 * folded into data-free messages: known errors print their constant
 * message, anything else prints the generic line, never raw diagnostics
 * (which could quote untrusted packet content).
 */
export function runAtomic(argv: readonly string[], io: AtomicIo): number {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if ((command === "setup" || command === "pay" || command === "status") && rest.length !== 0) {
      throw new AtomicCliError(USAGE);
    }
    if (command === "setup") {
      return runSetup(io);
    }
    if (command === "enroll") {
      return runEnroll(rest, io);
    }
    if (command === "pay") {
      return runPay(io);
    }
    if (command === "status") {
      return runStatus(io);
    }
    io.stderr(`${command === undefined ? USAGE : `Unknown command: expected 'setup', 'enroll', 'pay', or 'status'.\n\n${USAGE}`}`);
    return 1;
  } catch (err) {
    const message =
      err instanceof AtomicStoreError || err instanceof AtomicCliError
        ? err.message
        : GENERIC_FAILURE;
    io.stderr(`atomic: ${command ?? "atomic"} failed. ${message}`);
    return 1;
  }
}

/** True when executed as the CLI entry point (compiled dist or tsx run). */
function isMainModule(): boolean {
  return require.main === module;
}

if (isMainModule()) {
  const exiting = (line: string, stream: "stdout" | "stderr"): void => {
    (stream === "stdout" ? process.stdout : process.stderr).write(`${line}\n`);
  };
  process.exitCode = runAtomic(process.argv.slice(2), {
    stdout: (line) => exiting(line, "stdout"),
    stderr: (line) => exiting(line, "stderr"),
    now: () => Date.now(),
    env: process.env,
  });
}
