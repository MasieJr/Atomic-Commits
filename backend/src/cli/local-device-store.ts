/**
 * Local enrollment profile store for the offline `atomic` CLI (L3 consumer of
 * the domain TOTP contract in `src/domain/payment-engine/totp.ts`).
 *
 * PURPOSE
 * - Stores ONE per-user device enrollment profile (the strict trusted-import
 *   packet) in a dedicated per-user directory, and loads it back for
 *   `atomic pay` / `atomic status`. Never a database, never a network client.
 *
 * PACKET CONTRACT (strict trusted-import JSON)
 * - Exactly these fields, no more, no fewer:
 *     { "version": 2, "prefix": "4RTW", "secret": "<canonical Base32>",
 *       "algorithm": "SHA1", "codeEncoding": "BASE36-HOTP31",
 *       "codeLength": 6, "periodSeconds": 30,
 *       "expiresAtEpochMs": <safe integer>, "revoked": false }
 * - version MUST be 2 (unsupported versions fail closed); prefix MUST match
 *   [A-Z0-9]{4}; algorithm MUST be exactly "SHA1"; codeLength MUST be 6;
 *   periodSeconds MUST be 30; expiresAtEpochMs MUST be a non-negative safe
 *   integer; revoked MUST be exactly `false` (a locally known revoked packet
 *   never loads); the secret MUST decode to at least 160 bits (20 bytes).
 * - The >=160-bit floor is a CLI/store decision and is deliberately STRONGER
 *   than the domain module's >=128-bit floor: this store cannot verify actual
 *   secret randomness, only encoded length, so it refuses shorter seeds.
 * - "Exactly understood fields" means unknown, missing, or mistyped fields
 *   are rejected (fail closed), not skipped.
 *
 * AT-REST PROTECTION (documented demo-only level)
 * - POSIX: dedicated directory mode 0700, profile file mode 0600.
 * - Windows: user-ONLY ACL, with inheritance DISABLED and all other explicit
 *   ACEs removed. The grant is made by SID (resolved through the OS, never a
 *   possibly-untrusted username) and is re-verified after every write and
 *   before every load.
 * - This is NOT a secure enclave: the account owner, malware running in the
 *   same user session, or a physical attacker can still read the value. No
 *   stronger guarantee is claimed.
 * - FAIL CLOSED: the directory is protected BEFORE the secret file exists, so
 *   failed directory protection never leaves a secret behind. If file
 *   protection fails after writing, the file is deleted and the error
 *   surfaces. A load only succeeds while both protections still hold.
 *
 * PATH DISCIPLINE
 * - Symlinks/reparse points anywhere on the profile path are rejected.
 * - An existing directory is reused ONLY when it is empty or contains solely
 *   this store's own profile file. Arbitrary pre-existing parent directories
 *   are never chmod'd or ACL'd. Overwrite is refused: enrollment is one-shot.
 * - `ATOMIC_DEVICE_HOME` (absolute path) overrides the default per-user
 *   location, for isolated testing. Secrets are never taken from, or placed
 *   into, the environment by this module.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isValidTotpSecret } from "../domain/payment-engine/totp";

/** Name of the single profile file inside the dedicated device directory. */
export const DEVICE_PROFILE_FILENAME = "device-profile.json";

/** Packet schema accepted by this store (version, then fixed fields). */
export type DeviceProfile = {
  readonly version: 2;
  readonly prefix: string;
  readonly secret: string;
  readonly algorithm: "SHA1";
  readonly codeEncoding: "BASE36-HOTP31";
  readonly codeLength: 6;
  readonly periodSeconds: 30;
  readonly expiresAtEpochMs: number;
  readonly revoked: false;
};

/** Allowed packet keys, in canonical storage order. */
const PACKET_FIELDS = [
  "version",
  "prefix",
  "secret",
  "algorithm",
  "codeEncoding",
  "codeLength",
  "periodSeconds",
  "expiresAtEpochMs",
  "revoked",
] as const;

const LEGACY_PACKET_FIELDS = ["version", "prefix", "secret", "algorithm", "digits", "periodSeconds", "expiresAtEpochMs", "revoked"] as const;
const PACKET_VERSION = 2;
const PACKET_ALGORITHM = "SHA1" as const;
const PACKET_CODE_ENCODING = "BASE36-HOTP31" as const;
const PACKET_CODE_LENGTH = 6;
const PACKET_PERIOD_SECONDS = 30;
/** CLI/store secret floor: at least 160 decoded bits (20 bytes). */
const MIN_SECRET_BYTES = 20;
/** New aliases are exactly four uppercase alphanumeric characters. */
const PREFIX_PATTERN = /^[A-Z0-9]{4}$(?![\s\S])/;
const LEGACY_PREFIX_PATTERN = /^[A-Z0-9]{4,12}$(?![\s\S])/;

/**
 * Error whose message is SAFE to show the user: constant, data-free, and
 * guaranteed never to echo secret material or untrusted packet content.
 */
export class AtomicStoreError extends Error {}

/** Data-free failure messages (never echo packet content or the secret). */
const MISSING_PROFILE =
  "No local device profile is enrolled. Run 'atomic enroll --file <packet path>' first.";
const PROFILE_NOT_A_FILE = "The local device profile is not a regular file.";
const MALFORMED_PROFILE = "The local device profile is corrupt or has unsupported fields.";
const PROFILE_REVOKED = "The local device profile is marked revoked.";
const PROFILE_EXPIRED = "The local device profile is locally expired.";
const PROTECTION_REGRESSED =
  "Local device profile protection is no longer intact; refusing to use it.";
const PROFILE_PATH_SYMLINK =
  "Refusing to store or load the device profile: the path contains a symlink or reparse point.";
const DEVICE_DIR_UNUSABLE = "Refusing to use the device directory: it is not an empty dedicated directory.";
const DIR_PROTECTION_FAILED = "Failed to protect the device directory; no device secret was written.";
const FILE_PROTECTION_FAILED = "Failed to protect the device profile file; its contents were removed.";
const FILE_REMOVAL_FAILED =
  "Failed to protect the device profile file and to remove it; delete it before re-enrolling.";
const ALREADY_ENROLLED =
  "A device profile already exists; refusing to overwrite. Delete it explicitly to re-enroll.";
const DEVICE_DIR_CREATE_FAILED = "Failed to create the dedicated device directory.";
const PROFILE_NOT_WRITTEN = "Failed to write the device profile file.";
const UNREADABLE_PROFILE = "The local device profile could not be read.";
const UNSUPPORTED_VERSION = "Enrollment packet version is unsupported.";
const UNSUPPORTED_PARAMETERS = "Enrollment packet fields are missing, mistyped, or unsupported.";
const PACKET_EXPIRED = "Enrollment packet is already expired.";
const ACL_UNAVAILABLE = "Windows ACL protection is unavailable in this environment.";
const PATH_OVERRIDE_INVALID = "ATOMIC_DEVICE_HOME must be an absolute path when set.";
const PROFILE_HOME_UNREADABLE = "The device directory could not be inspected.";
const PROFILE_UPGRADE_FAILED = "The local device profile could not be safely upgraded; check its protection and retry.";

/**
 * Loads a profile iff it exists, is regular, un-symlinked, still protected,
 * and schema-valid. Expiry is NOT enforced here: `atomic status` may report
 * the locally stored expiry factually (never as a validity claim);
 * `assertProfileUsable` is the fail-closed check used by the pay path.
 */
export function loadDeviceProfile(home: string, _nowEpochMs = Date.now()): DeviceProfile {
  return validateDeviceProfile(strictJsonParse(readProtectedProfile(home)));
}

/** Read a profile only after checking its location and at-rest protection. */
function readProtectedProfile(home: string): string {
  let homeStat: ReturnType<typeof lstatSync>;
  try {
    homeStat = lstatSync(home);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AtomicStoreError(MISSING_PROFILE);
    throw new AtomicStoreError(PROFILE_HOME_UNREADABLE);
  }
  if (homeStat.isSymbolicLink()) {
    throw new AtomicStoreError(PROFILE_PATH_SYMLINK);
  }
  if (!homeStat.isDirectory()) {
    throw new AtomicStoreError(DEVICE_DIR_UNUSABLE);
  }
  const profilePath = deviceProfilePath(home);
  let fileStat: ReturnType<typeof lstatSync>;
  try {
    fileStat = lstatSync(profilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AtomicStoreError(MISSING_PROFILE);
    throw new AtomicStoreError(UNREADABLE_PROFILE);
  }
  if (fileStat.isSymbolicLink()) {
    throw new AtomicStoreError(PROFILE_PATH_SYMLINK);
  }
  if (!fileStat.isFile()) {
    throw new AtomicStoreError(PROFILE_NOT_A_FILE);
  }
  // Path integrity before protection, protection before content, content
  // before trust: any failure closes the door before the secret is read.
  scanForSymlinks(profilePath);
  assertRealPathMatches(profilePath);
  verifyDeviceProtection(home, profilePath);
  let text: string;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch {
    throw new AtomicStoreError(UNREADABLE_PROFILE);
  }
  return text;
}

/** Fail-closed usability: rejects locally known revoked or expired profiles. */
export function assertProfileUsable(profile: DeviceProfile, nowEpochMs: number): void {
  if (profile.revoked !== false) {
    throw new AtomicStoreError(PROFILE_REVOKED);
  }
  if (profile.expiresAtEpochMs <= nowEpochMs) {
    throw new AtomicStoreError(PROFILE_EXPIRED);
  }
}

/** True when the profile's locally stored expiry instant has passed. */
export function isProfileExpired(profile: DeviceProfile, nowEpochMs: number): boolean {
  return profile.expiresAtEpochMs <= nowEpochMs;
}

/** Distinguishes "nothing enrolled" from "enrollment present but unusable". */
export function isMissingProfileError(err: unknown): boolean {
  return err instanceof AtomicStoreError && err.message === MISSING_PROFILE;
}

/**
 * Strict trusted-import parser: JSON text in, validated profile out. Throws
 * AtomicStoreError (constant, data-free messages) on anything malformed,
 * including packets whose locally stored expiry instant has already passed.
 */
export function parseEnrollmentPacket(text: string, nowEpochMs: number): DeviceProfile {
  const profile = validateDeviceProfile(strictJsonParse(text));
  if (profile.expiresAtEpochMs <= nowEpochMs) {
    throw new AtomicStoreError(PACKET_EXPIRED);
  }
  return profile;
}

/**
 * Validates an already-parsed packet value against the exact contract:
 * exactly understood fields, supported version and parameters, canonical
 * Base32 secret with at least 160 decoded bits, revoked exactly false.
 * Returns a NEW object in fixed field order (safe for canonical storage).
 */
export function validateDeviceProfile(value: unknown): DeviceProfile {
  return validateProfile(value, false).profile;
}

function validateProfile(value: unknown, allowLegacy: boolean): { profile: DeviceProfile; legacyPrefix?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AtomicStoreError(MALFORMED_PROFILE);
  }
  const packet = value as Record<string, unknown>;
  const legacy = allowLegacy && packet.version === 1;
  if (!legacy && packet.version !== PACKET_VERSION) {
    throw new AtomicStoreError(UNSUPPORTED_VERSION);
  }
  const fields: readonly string[] = legacy ? LEGACY_PACKET_FIELDS : PACKET_FIELDS;
  const keys = Object.keys(packet);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field))
  ) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  const prefix = packet.prefix;
  if (typeof prefix !== "string" || !(legacy ? LEGACY_PREFIX_PATTERN : PREFIX_PATTERN).test(prefix)) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  if (!isValidTotpSecret(packet.secret, MIN_SECRET_BYTES)) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  if (packet.algorithm !== PACKET_ALGORITHM) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  if (legacy ? packet.digits !== 6 :
    packet.codeEncoding !== PACKET_CODE_ENCODING || packet.codeLength !== PACKET_CODE_LENGTH) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  if (packet.periodSeconds !== PACKET_PERIOD_SECONDS) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  const expiresAtEpochMs = packet.expiresAtEpochMs;
  if (
    typeof expiresAtEpochMs !== "number" ||
    !Number.isSafeInteger(expiresAtEpochMs) ||
    expiresAtEpochMs < 0 ||
    !Number.isFinite(new Date(expiresAtEpochMs).getTime())
  ) {
    throw new AtomicStoreError(UNSUPPORTED_PARAMETERS);
  }
  if (packet.revoked !== false) {
    throw new AtomicStoreError(PROFILE_REVOKED);
  }
  return {
    profile: {
      version: 2,
      prefix: legacy ? prefix.slice(0, 4) : prefix,
      secret: packet.secret as string,
      algorithm: "SHA1",
      codeEncoding: "BASE36-HOTP31",
      codeLength: 6,
      periodSeconds: 30,
      expiresAtEpochMs,
      revoked: false,
    },
    ...(legacy ? { legacyPrefix: prefix } : {}),
  };
}

/**
 * JSON.parse with guarded failure: malformed input raises a constant,
 * content-free error (raw parser messages can quote fragments of the packet,
 * which may contain the secret).
 */
function strictJsonParse(text: string): unknown {
  try {
    // Windows PowerShell 5.1 commonly writes UTF-8 with a single BOM.
    return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text) as unknown;
  } catch {
    throw new AtomicStoreError(MALFORMED_PROFILE);
  }
}

/**
 * Canonical, fixed-order JSON serialization of a validated profile. Only
 * the contract fields are stored, in the declared order.
 */
function serializeProfile(profile: DeviceProfile): string {
  return `${JSON.stringify(
    {
      version: profile.version,
      prefix: profile.prefix,
      secret: profile.secret,
      algorithm: profile.algorithm,
      codeEncoding: profile.codeEncoding,
      codeLength: profile.codeLength,
      periodSeconds: profile.periodSeconds,
      expiresAtEpochMs: profile.expiresAtEpochMs,
      revoked: profile.revoked,
    },
    null,
    2,
  )}\n`;
}

/** Upgrade a protected v1 profile without replacing its secret or expiry. */
export function prepareExistingDeviceProfile(home: string, nowEpochMs: number): { profile: DeviceProfile; upgraded: boolean } {
  const original = readProtectedProfile(home);
  const parsed = validateProfile(strictJsonParse(original), true);
  assertProfileUsable(parsed.profile, nowEpochMs);
  if (parsed.legacyPrefix === undefined) return { profile: parsed.profile, upgraded: false };

  const profilePath = deviceProfilePath(home);
  const temporary = path.join(home, `.atomic-profile-${randomBytes(12).toString("hex")}.tmp`);
  let created = false;
  try {
    // The enclosing directory is already protected; the temporary profile is
    // protected and checked before replacing the original on the same volume.
    writeFileSync(temporary, serializeProfile(parsed.profile), { mode: 0o600, flag: "wx" });
    created = true;
    protectFile(temporary);
    verifyDeviceProtection(home, temporary);
    if (readProtectedProfile(home) !== original) throw new Error("Profile changed during upgrade");
    renameSync(temporary, profilePath);
    created = false;
    verifyDeviceProtection(home, profilePath);
  } catch {
    if (created) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
    throw new AtomicStoreError(PROFILE_UPGRADE_FAILED);
  }
  return { profile: parsed.profile, upgraded: true };
}

/** Profile path inside a device directory (paths are not secret material). */
export function deviceProfilePath(home: string): string {
  return path.join(home, DEVICE_PROFILE_FILENAME);
}

/**
 * Saves a VALIDATED profile, fail-closed:
 *   1. prepare the dedicated directory (one-shot rule + symlink scan),
 *   2. protect the directory BEFORE any secret exists on disk,
 *   3. write the profile file exclusively (never overwrite),
 *   4. protect the file (chmod/ACL), deleting it on protection failure.
 */
export function saveDeviceProfile(home: string, profile: DeviceProfile): { profilePath: string } {
  const profilePath = deviceProfilePath(home);
  prepareDeviceDir(home);
  protectDirectory(home);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(profilePath);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    throw new AtomicStoreError(ALREADY_ENROLLED);
  }
  try {
    writeFileSync(profilePath, serializeProfile(profile), { mode: 0o600, flag: "wx" });
  } catch {
    throw new AtomicStoreError(PROFILE_NOT_WRITTEN);
  }
  protectFile(profilePath);
  return { profilePath };
}

/**
 * Prepares the dedicated device directory. Creates only the leaf directory
 * (missing ancestors are created recursively with default modes and are NOT
 * protected: only the leaf is dedicated). An EXISTING directory is accepted
 * only if it is empty or contains solely this store's profile file; anything
 * else makes the CLI refuse without altering the directory.
 */
function prepareDeviceDir(home: string): void {
  if (existsSync(home)) {
    let homeStat: ReturnType<typeof lstatSync>;
    try {
      homeStat = lstatSync(home);
    } catch {
      throw new AtomicStoreError(DEVICE_DIR_CREATE_FAILED);
    }
    if (!homeStat.isDirectory()) {
      throw new AtomicStoreError(DEVICE_DIR_UNUSABLE);
    }
    let entries: string[];
    try {
      entries = readdirSync(home);
    } catch {
      throw new AtomicStoreError(PROFILE_HOME_UNREADABLE);
    }
    if (entries.some((entry) => entry !== DEVICE_PROFILE_FILENAME)) {
      throw new AtomicStoreError(DEVICE_DIR_UNUSABLE);
    }
  } else {
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      throw new AtomicStoreError(DEVICE_DIR_CREATE_FAILED);
    }
  }
  scanForSymlinks(deviceProfilePath(home));
}

/** Protects the dedicated directory (0700 POSIX / user-only ACL Windows). */
function protectDirectory(home: string): void {
  try {
    if (process.platform === "win32") {
      applyUserOnlyAclWindows(home, "dir");
    } else {
      chmodSync(home, 0o700);
      const stat = statSync(home);
      if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) {
        throw new AtomicStoreError(DIR_PROTECTION_FAILED);
      }
    }
  } catch (err) {
    if (err instanceof AtomicStoreError) throw err;
    throw new AtomicStoreError(DIR_PROTECTION_FAILED);
  }
}

/** Protects the profile file (0600 POSIX / user-only ACL Windows). */
function protectFile(profilePath: string): void {
  try {
    if (process.platform === "win32") {
      applyUserOnlyAclWindows(profilePath, "file");
    } else {
      chmodSync(profilePath, 0o600);
      const stat = statSync(profilePath);
      if ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
        throw new AtomicStoreError(FILE_PROTECTION_FAILED);
      }
    }
  } catch (err) {
    // Fail closed: a secret file inside an unprotected directory must go.
    let removed = false;
    try {
      unlinkSync(profilePath);
      removed = true;
    } catch {
      // Best-effort cleanup; escalated below.
    }
    throw new AtomicStoreError(removed ? FILE_PROTECTION_FAILED : FILE_REMOVAL_FAILED);
  }
}

/**
 * Verification used on every load: POSIX checks the stored modes; Windows
 * re-reads the DACL of both directory and file in ONE child invocation and
 * requires: protection flag set (inheritance disabled), exactly ONE access
 * ACE, Allow FullControl, resolved to the CURRENT user's SID, nothing
 * inherited. Any mismatch fails closed before the secret is read.
 */
function verifyDeviceProtection(home: string, profilePath: string): void {
  if (process.platform === "win32") {
    verifyUserOnlyAclWindows([
      { target: home, kind: "dir" },
      { target: profilePath, kind: "file" },
    ]);
    return;
  }
  const dirStat = statSync(home);
  const fileStat = statSync(profilePath);
  if ((dirStat.mode & 0o777) !== 0o700 || dirStat.uid !== process.getuid?.()) {
    throw new AtomicStoreError(PROTECTION_REGRESSED);
  }
  if ((fileStat.mode & 0o777) !== 0o600 || fileStat.uid !== process.getuid?.()) {
    throw new AtomicStoreError(PROTECTION_REGRESSED);
  }
}

/**
 * Rejects symlinks/reparse points along the profile path (parent components
 * and the leaf). ENOENT components (not yet created) are skipped.
 */
function scanForSymlinks(profilePath: string): void {
  const absolute = path.resolve(profilePath);
  let current = path.parse(absolute).root;
  const parts = absolute
    .slice(current.length)
    .split(path.sep)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    current = path.join(current, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      continue; // Component does not exist yet; nothing to reject here.
    }
    if (st.isSymbolicLink()) {
      throw new AtomicStoreError(PROFILE_PATH_SYMLINK);
    }
  }
}

/**
 * Extra read-path guard: the resolved realpath of the profile file must be
 * the same path (case-insensitively on Windows), so a swapped link target
 * cannot be read transparently.
 */
function assertRealPathMatches(profilePath: string): void {
  let real: string;
  try {
    real = realpathSync(profilePath);
  } catch {
    throw new AtomicStoreError(UNREADABLE_PROFILE);
  }
  const same =
    process.platform === "win32"
      ? real.toLowerCase() === profilePath.toLowerCase()
      : real === profilePath;
  if (!same) {
    throw new AtomicStoreError(PROFILE_PATH_SYMLINK);
  }
}

/* ============================ Windows ACL layer ============================ */

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new AtomicStoreError(ACL_UNAVAILABLE);
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(candidate)) throw new AtomicStoreError(ACL_UNAVAILABLE);
  return candidate;
}

function runPowershell(script: string): string {
  if (process.platform !== "win32") {
    throw new AtomicStoreError(ACL_UNAVAILABLE);
  }
  const result = spawnSync(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new AtomicStoreError(ACL_UNAVAILABLE);
  }
  return (result.stdout ?? "").trim();
}

let cachedSid: string | undefined;

/**
 * Current user SID, resolved through the operating system rather than any
 * username environment value (USERPROFILE/USERNAME are user-controlled and
 * untrusted for ACL identity decisions).
 */
function currentUserSidWindows(): string {
  if (cachedSid !== undefined) return cachedSid;
  const output = runPowershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  const sid = output.trim();
  if (!/^S-1-\d(-\d+)+$/.test(sid)) {
    throw new AtomicStoreError(ACL_UNAVAILABLE);
  }
  cachedSid = sid;
  return sid;
}

/** Single-quote escaping for literal PowerShell string data. */
function escapePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Shared DACL verification body (PowerShell). Operates on $target,
 * $expectedSid, and $isDir: protection flag set, exactly ONE access ACE,
 * Allow FullControl resolved to the expected SID, nothing inherited, and no
 * reparse point on the item itself.
 */
const ACL_VERIFY_BODY = /* PowerShell */ `
$item = Get-Item -LiteralPath $target -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'reparse-point-present' }
if ($isDir) {
  if (-not $item.PSIsContainer) { throw 'not-a-directory' }
} else {
  if ($item.PSIsContainer) { throw 'not-a-file' }
}
$acl = Get-Acl -LiteralPath $target
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $expectedSid) { throw 'owner-mismatch' }
if (-not $acl.AreAccessRulesProtected) { throw 'inheritance-not-disabled' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw "unexpected-ace-count:$($rules.Count)" }
$rule = $rules[0]
if ($rule.IsInherited) { throw 'inherited-ace-present' }
if ($rule.AccessControlType.ToString() -ne 'Allow') { throw 'ace-not-allow' }
if ($rule.FileSystemRights.ToString() -ne 'FullControl') { throw 'ace-not-fullcontrol' }
if ($rule.IdentityReference.Value -ne $expectedSid) { throw 'ace-identity-mismatch' }
`;

/**
 * Windows dir/file ACL user-only protection:
 *  - dir: protected DACL; single Allow FullControl ACE for the
 *    current user's SID, inheritable down the dedicated subtree.
 *  - file: protected DACL; single Allow FullControl for the SID.
 *  - both: inheritance DISABLED and every other explicit or inherited ACE
 *    removed, then verified by re-reading the ACL in the same invocation.
 */
function applyUserOnlyAclWindows(target: string, kind: "dir" | "file"): void {
  const sid = currentUserSidWindows();
  const inheritanceFlags =
    kind === "dir"
      ? "([System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit')"
      : "([System.Security.AccessControl.InheritanceFlags]::None)";
  const isDirLiteral = kind === "dir" ? "$true" : "$false";
  const script = `
$ErrorActionPreference = 'Stop'
$target = ${escapePowerShell(target)}
$expectedSid = ${escapePowerShell(sid)}
$isDir = ${isDirLiteral}
$item = Get-Item -LiteralPath $target -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'reparse-point-present' }
if ($isDir) {
  if (-not $item.PSIsContainer) { throw 'not-a-directory' }
} else {
  if ($item.PSIsContainer) { throw 'not-a-file' }
}
$sid = New-Object System.Security.Principal.SecurityIdentifier($expectedSid)
if ($item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $expectedSid) { throw 'owner-mismatch' }
$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
  $acl.RemoveAccessRuleSpecific($existing)
}
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, ${inheritanceFlags}, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
${ACL_VERIFY_BODY}
[Console]::Out.Write('OK')
`;
  const failure = kind === "dir" ? DIR_PROTECTION_FAILED : FILE_PROTECTION_FAILED;
  let output: string;
  try {
    output = runPowershell(script);
  } catch (err) {
    if (err instanceof AtomicStoreError && err.message !== ACL_UNAVAILABLE) throw err;
    throw new AtomicStoreError(failure);
  }
  // Every non-'OK' outcome already surfaced as a child-error exit code above;
  // belt-and-braces check for a truncated success channel.
  if (output !== "OK") {
    throw new AtomicStoreError(failure);
  }
}

/**
 * Windows load-time ACL re-verification for one or more DACL targets in a
 * single child invocation (cheap enough for pay/status per-run).
 */
function verifyUserOnlyAclWindows(targets: ReadonlyArray<{ target: string; kind: "dir" | "file" }>): void {
  const sid = currentUserSidWindows();
  const calls = targets
    .map((entry) => `Test-One ${entry.kind === "dir" ? "$true" : "$false"} ${escapePowerShell(entry.target)} ${escapePowerShell(sid)}`)
    .join("\n");
  const script = `
$ErrorActionPreference = 'Stop'
function Test-One($isDir, $target, $expectedSid) {
${ACL_VERIFY_BODY}
}
$expectedSid = ${escapePowerShell(sid)}
${calls}
[Console]::Out.Write('OK')
`;
  let output: string;
  try {
    output = runPowershell(script);
  } catch (err) {
    if (err instanceof AtomicStoreError && err.message !== ACL_UNAVAILABLE) throw err;
    throw new AtomicStoreError(PROTECTION_REGRESSED);
  }
  if (output !== "OK") {
    throw new AtomicStoreError(PROTECTION_REGRESSED);
  }
}

/**
 * Default dedicated per-user device directory:
 * - Windows: <APPDATA>\atomic-commits\device (falls back to the profile
 *   directory when APPDATA is absent or not absolute).
 * - POSIX: XDG_DATA_HOME (if absolute) else ~/.local/share, then
 *   /atomic-commits/device. The leaf directory itself is the protected
 *   dedicated directory; nothing else is ever modified.
 */
export function resolveDeviceHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.ATOMIC_DEVICE_HOME;
  if (override !== undefined && override.trim().length > 0) {
    if (!path.isAbsolute(override)) {
      throw new AtomicStoreError(PATH_OVERRIDE_INVALID);
    }
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA && path.isAbsolute(env.APPDATA)
      ? env.APPDATA
      : path.join(homedir(), "AppData", "Roaming");
    return path.join(appData, "atomic-commits", "device");
  }
  const dataRoot = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "atomic-commits", "device");
}
