/**
 * TOTP payment code — pure generator/verifier.
 *
 * - 30-second RFC 6238 counter and HMAC-SHA1 with RFC 4226 dynamic
 *   truncation. The 31-bit result is encoded as six uppercase base36
 *   characters, left-padded with zeroes. This presentation is NOT compatible
 *   with standard six-decimal-digit TOTP; both sides must use this contract.
 * - No database, no network, no internal clock: `atEpochMs` is injected on
 *   every call as a non-negative safe-integer number of epoch milliseconds.
 *   `expiresAtEpochMs` is the exact step-aligned instant
 *   (timeStep + 1) * 30 000.
 *
 * SECRETS — canonical RFC 4648 Base32, case-insensitive:
 * - [A-Z2-7] with an optional single trailing '=' run padding the string to
 *   a multiple of 8 characters (canonical pad lengths only: letter residues
 *   2/4/5/7 -> 6/4/3/1 '=' and full groups carry no padding).
 * - Rejected: whitespace, "0"/"1"/"8"/"9" (Base32hex only), non-ASCII input,
 *   internal or wrong-length padding, letter residues 1/3/6, nonzero unused
 *   trailing bits of the final partial group, and keys below 16 bytes (the
 *   RFC 6238 128-bit seed-strength recommendation). Case and optional padding
 *   can represent the same key.
 *
 * FAILURE MODES:
 * - generateTotp and formatPaymentCode are construction entry points and
 *   THROW generic, constant, data-free errors on invalid input.
 * - verifyTotp is an accept/reject boundary and FAILS CLOSED: malformed
 *   secret, code, or time returns `{ valid: false }` without throwing.
 * - `allowedDriftSteps` is caller configuration, not untrusted input: it
 *   must be a safe integer 0..1 (current step plus at most one adjacent).
 *   Any other value THROWS rather than being silently widened.
 *
 * WINDOW SEMANTICS AND COLLISIONS:
 * - Candidates are probed in a FIXED order — current step, one step
 *   earlier, one step later (never before the epoch) — and the first match
 *   determines the reported timeStep, so identical inputs always yield
 *   identical results.
 * - The 31-bit output space is finite, so distinct steps CAN share a code,
 *   and the same presented code can also be accepted at two different
 *   clocks, each resolving to its own timeStep. Verification is NOT replay
 *   protection: the backend MUST atomically claim the (device, timeStep)
 *   that verifyTotp returns. A TOTP does not sign an amount, a merchant,
 *   or consent.
 * - The presented code is compared with timingSafeEqual (equal length,
 *   content only). No broader timing guarantees are claimed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Fixed demo window: codes rotate every 30 seconds; expiry is step-aligned. */
export const TOTP_TIME_STEP_MS = 30_000;

export type TotpGeneration = {
  readonly code: string;
  readonly timeStep: number;
  readonly expiresAtEpochMs: number;
};

export type TotpVerification =
  | { readonly valid: true; readonly timeStep: number }
  | { readonly valid: false };

const CODE_LENGTH = 6;
/** RFC 6238 recommends seeds of at least 128 bits. */
const MIN_SECRET_BYTES = 16;
/** The backend contract allows the current step plus at most one adjacent. */
const MAX_ALLOWED_DRIFT_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/**
 * Valid Base32 letter-run residues mod 8: a full group (0) and precisely the
 * residues that decode to whole bytes (2,4,5,7 letters -> 1,2,3,4 bytes).
 * Residues 1,3,6 can never canonicalize to whole bytes and are malformed.
 */
const CANONICAL_BASE32_RESIDUES = [2, 4, 5, 7] as const;

// The negative lookahead requires the actual end of the string: JavaScript's
// `$` alone also matches just before a trailing newline.
const CODE_PATTERN = /^[A-Z0-9]{6}$(?![\s\S])/;
/** Public routing alias: exactly four uppercase ASCII letters or digits. */
const PAYMENT_CODE_PREFIX_PATTERN = /^[A-Z0-9]{4}$(?![\s\S])/;
/** Full presented form: XXXX-XXXXXX with nothing else attached. */
const PAYMENT_CODE_PATTERN = /^([A-Z0-9]{4})-([A-Z0-9]{6})$(?![\s\S])/;

/** Generic construction-time error messages; constant and data-free. */
const INVALID_TOTP_TIME = "TOTP time must be a non-negative whole number of milliseconds.";
const INVALID_TOTP_SECRET = "TOTP secret is missing, malformed, or below the strength floor.";
const INVALID_TOTP_DRIFT = "TOTP drift window is outside the supported 0..1 adjacent-step range.";
const INVALID_PAYMENT_CODE_PREFIX = "Payment code prefix must be four uppercase A-Z/0-9 characters.";
const INVALID_PAYMENT_CODE_BODY = "Payment code must be six uppercase A-Z/0-9 characters.";

/**
 * Validated positive-safe-integer time, whole milliseconds since the epoch.
 * Throws on fractional, NaN/Infinity, out-of-range, negative, or non-number
 * values — construction resolves defects loudly, verification resolves them
 * silently (see verifyTotp).
 */
function assertValidAtEpochMs(atEpochMs: number): number {
  if (
    typeof atEpochMs !== "number" ||
    !Number.isSafeInteger(atEpochMs) ||
    atEpochMs < 0
  ) {
    throw new Error(INVALID_TOTP_TIME);
  }
  return atEpochMs;
}

function hasCanonicalBase32Length(letterCount: number): boolean {
  const residue = letterCount % 8;
  return (
    residue === 0 ||
    (CANONICAL_BASE32_RESIDUES as readonly number[]).includes(residue)
  );
}

/**
 * Decode a canonical RFC 4648 Base32 secret; returns null instead of throwing
 * when encoding is malformed so verifyTotp can fail closed. See the module
 * header for the full strictness rules. The case-insensitive pattern is
 * tested against the RAW string (not an .toUpperCase() copy) so non-ASCII
 * characters whose Unicode upper-case mapping is an ASCII letter ("SS", "I")
 * cannot sneak through.
 */
function decodeBase32Secret(secret: unknown): Uint8Array | null {
  if (typeof secret !== "string" || secret.length === 0) return null;
  const match = /^([A-Za-z2-7]+)(=*)$(?![\s\S])/.exec(secret);
  if (match === null) return null;
  const letters = match[1].toUpperCase();
  const padding = match[2];
  const residue = letters.length % 8;
  if (residue === 0) {
    // Full letter groups are canonical only without padding.
    return padding === "" ? decodeBase32Letters(letters) : null;
  }
  if (padding === "") {
    // Unpadded partial groups are canonical for residues 2/4/5/7 (the bits
    // emit whole bytes and the unused trailing bits are checked inside).
    return hasCanonicalBase32Length(letters.length)
      ? decodeBase32Letters(letters)
      : null;
  }
  if (padding.length !== 8 - residue) return null; // Canonical pad length only.
  if (!hasCanonicalBase32Length(letters.length)) return null;
  return decodeBase32Letters(letters);
}

/**
 * Core bit-accumulator decoder for an already validated uppercase letter run.
 * Unconsumed bits (always fewer than 8) are masked after each letter, so the
 * accumulator stays small and bit-exact for secrets of any length.
 */
function decodeBase32Letters(letters: string): Uint8Array | null {
  const bytes: number[] = [];
  let acc = 0;
  let unconsumedBits = 0;
  for (let position = 0; position < letters.length; position += 1) {
    const index = BASE32_ALPHABET.indexOf(letters[position]);
    if (index === -1) return null; // Unreachable given the pattern check above.
    acc = (acc << 5) | index;
    unconsumedBits += 5;
    if (unconsumedBits >= 8) {
      bytes.push((acc >>> (unconsumedBits - 8)) & 0xff);
      unconsumedBits -= 8;
      acc &= (1 << unconsumedBits) - 1;
    }
  }
  // Canonical final group: unused low bits must be zero, or truncation could
  // map two different secrets onto the same key.
  if (unconsumedBits > 0 && acc !== 0) return null;
  if (bytes.length < MIN_SECRET_BYTES) return null;
  return Uint8Array.from(bytes);
}

/** Check canonical encoding and a minimum decoded length, not randomness. */
export function isValidTotpSecret(secret: unknown, minimumBytes = MIN_SECRET_BYTES): boolean {
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < MIN_SECRET_BYTES) return false;
  const key = decodeBase32Secret(secret);
  return key !== null && key.length >= minimumBytes;
}

/** Encode the RFC 4226 31-bit dynamic truncation as six uppercase base36 characters. */
function hotpBase36(key: Uint8Array, counter: bigint): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter, 0);
  const digest = createHmac("sha1", key).update(counterBytes).digest();
  // Last nibble of the digest selects a 4-byte window with the top bit masked.
  const offset = digest[digest.length - 1] & 0x0f;
  const selector =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return selector.toString(36).toUpperCase().padStart(CODE_LENGTH, "0");
}

/** True iff the value is a bare six-character uppercase alphanumeric string. */
function isCode(code: unknown): code is string {
  return typeof code === "string" && CODE_PATTERN.test(code);
}

/**
 * Generate the TOTP for `atEpochMs`: the code for the time step containing
 * that instant, plus the step number and the exact epoch millisecond when
 * the code stops being current ((step + 1) * 30 000).
 *
 * Throws a generic Error on malformed secret or malformed time; safe inputs
 * always produce a well-formed six-character alphanumeric code.
 */
export function generateTotp(secret: string, atEpochMs: number): TotpGeneration {
  const time = assertValidAtEpochMs(atEpochMs);
  const key = decodeBase32Secret(secret);
  if (key === null) {
    throw new Error(INVALID_TOTP_SECRET);
  }
  const timeStep = Math.floor(time / TOTP_TIME_STEP_MS);
  const expiresAtEpochMs = (timeStep + 1) * TOTP_TIME_STEP_MS;
  if (!Number.isSafeInteger(expiresAtEpochMs)) throw new Error(INVALID_TOTP_TIME);
  return {
    code: hotpBase36(key, BigInt(timeStep)),
    timeStep,
    expiresAtEpochMs,
  };
}

/** RFC 6238 decimal presentation used by the current API branch. */
export function generateDecimalTotp(secret: string, atEpochMs: number): TotpGeneration {
  const generated = generateTotp(secret, atEpochMs);
  const truncated = Number.parseInt(generated.code, 36);
  return { ...generated, code: String(truncated % 1_000_000).padStart(6, "0") };
}

/**
 * Verify a presented six-character code against the secret at `atEpochMs`,
 * accepting the drift window given by `allowedDriftSteps`
 * (0 = current step only, 1 = current plus one step on each side, never
 * before the epoch). The window is never widened: a `allowedDriftSteps`
 * outside the supported 0..1 range throws. FAILS CLOSED: malformed secret,
 * malformed code, or malformed time returns `{ valid: false }` without
 * throwing.
 *
 * Deterministic: candidates are always probed as current step first, then
 * one step earlier, then one step later, and the first match is returned —
 * see the header note on code collisions. The returned timeStep is the
 * key the backend must atomically claim exactly once.
 *
 * Throws only on an out-of-range `allowedDriftSteps`, which is caller
 * configuration misuse, not untrusted client input.
 */
export function verifyTotp(
  secret: string,
  code: unknown,
  atEpochMs: number,
  allowedDriftSteps: number,
): TotpVerification {
  if (
    typeof allowedDriftSteps !== "number" ||
    !Number.isSafeInteger(allowedDriftSteps) ||
    allowedDriftSteps < 0 ||
    allowedDriftSteps > MAX_ALLOWED_DRIFT_STEPS
  ) {
    throw new Error(INVALID_TOTP_DRIFT);
  }
  const key = decodeBase32Secret(secret);
  if (key === null) return { valid: false };
  if (!isCode(code)) return { valid: false };
  if (
    typeof atEpochMs !== "number" ||
    !Number.isSafeInteger(atEpochMs) ||
    atEpochMs < 0
  ) {
    return { valid: false };
  }

  const provided = Buffer.from(code, "utf8");
  const timeStep = Math.floor(atEpochMs / TOTP_TIME_STEP_MS);
  const stepOffsets: readonly number[] =
    allowedDriftSteps === 0 ? [0] : [0, -1, 1];
  for (const offset of stepOffsets) {
    const candidateStep = timeStep + offset;
    if (candidateStep < 0) continue;
    const candidate = Buffer.from(
      hotpBase36(key, BigInt(candidateStep)),
      "utf8",
    );
    // Equal-length, content-only, constant-time comparison.
    if (timingSafeEqual(candidate, provided)) {
      return { valid: true, timeStep: candidateStep };
    }
  }
  return { valid: false };
}

/**
 * Render "XXXX-XXXXXX": exactly four and six uppercase alphanumeric
 * characters, separated by one hyphen. No trimming or case normalization.
 */
export function formatPaymentCode(prefix: string, code: string): string {
  if (typeof prefix !== "string" || !PAYMENT_CODE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(INVALID_PAYMENT_CODE_PREFIX);
  }
  if (!isCode(code)) {
    throw new Error(INVALID_PAYMENT_CODE_BODY);
  }
  return `${prefix}-${code}`;
}

/**
 * Strictly parse a presented payment code. Accepts ONLY the exact shape
 * "XXXX-XXXXXX" produced by formatPaymentCode — one hyphen, four ASCII
 * uppercase A-Z/0-9 prefix characters, six alphanumeric code characters, no
 * surrounding or internal whitespace, no lowercase, no extra separators or
 * trailing content. Returns undefined (not an error) for anything else, so
 * endpoint callers can treat parse failure uniformly as client error.
 */
export function parsePaymentCode(
  input: unknown,
): { readonly prefix: string; readonly code: string } | undefined {
  if (typeof input !== "string") return undefined;
  const match = PAYMENT_CODE_PATTERN.exec(input);
  if (match === null) return undefined;
  return { prefix: match[1], code: match[2] };
}
