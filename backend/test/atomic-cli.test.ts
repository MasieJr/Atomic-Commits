import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { generateTotp, TOTP_TIME_STEP_MS } from '../src/domain/payment-engine/totp';

// Anchors: this file lives in backend/test, per the focused-test convention.
const backendRoot = path.resolve(__dirname, '..');
const cliPath = path.join(backendRoot, 'dist', 'src', 'commands', 'atomic.js');
const guardPath = path.join(backendRoot, 'test', 'atomic-network-guard.cjs');
const tscPath = path.join(backendRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * The compiled executable must wire a Node shebang so the dist artifact
 * itself (dist/src/commands/atomic.js) is runnable without any wrapper.
 */
test('build: tsc emits the compiled atomic CLI with a node shebang', { timeout: 300_000 }, () => {
  const build = spawnSync(process.execPath, [tscPath, '-p', backendRoot], { encoding: 'utf8' });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.ok(existsSync(cliPath), 'dist/src/commands/atomic.js must exist after the build');
  const firstLine = readFileSync(cliPath, 'utf8').split(/\r?\n/, 1)[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
  assert.ok(existsSync(guardPath), 'the demo network guard must exist for guard tests');
});

/**
 * Canonical Base32 of 32 letters decodes to exactly 20 bytes (160 bits),
 * the CLI/store secret floor.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function randomSecretLetters(letterCount = 32): string {
  const bytes = randomBytes(letterCount);
  let secret = '';
  for (const byte of bytes) secret += BASE32_ALPHABET[byte % 32];
  return secret;
}

function makePacket(overrides: Record<string, unknown> = {}, secret?: string): Record<string, unknown> {
  return {
    version: 2,
    prefix: '4RTW',
    secret: secret ?? randomSecretLetters(),
    algorithm: 'SHA1',
    codeEncoding: 'BASE36-HOTP31',
    codeLength: 6,
    periodSeconds: 30,
    expiresAtEpochMs: Date.now() + 365 * 24 * 60 * 60 * 1000,
    revoked: false,
    ...overrides,
  };
}

function packetOverridesWithMutation(
  mutate: (packet: Record<string, unknown>) => void,
): Record<string, unknown> {
  const packet = makePacket();
  mutate(packet);
  return packet;
}

function randomizeFixtures(...label: string[]): string {
  return mkdtempSync(path.join(tmpdir(), `atomic-cli-${label.join('-')}-`));
}

function writePacketFile(dir: string, text: string): string {
  const packetPath = path.join(dir, 'enroll-packet.json');
  writeFileSync(packetPath, text, 'utf8');
  return packetPath;
}

type RunOptions = { home?: string; guard?: boolean };
type CliResult = { status: number; stdout: string; stderr: string };

/** Spawns the REAL CLI (compiled dist) as a child process. */
function runAtomicCli(args: readonly string[], options: RunOptions = {}): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, ATOMIC_ALLOW_LOCAL_DEMO: '1' };
  if (options.home !== undefined) env.ATOMIC_DEVICE_HOME = options.home;
  const childArgs: string[] = options.guard ? ['--require', guardPath] : [];
  childArgs.push(cliPath, ...args);
  const result = spawnSync(process.execPath, childArgs, { encoding: 'utf8', env, timeout: 120_000 });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Enrolls a packet file and asserts success; returns the profile path. */
function enrollWithPacketFile(
  t: TestContext,
  home: string,
  packetText: string,
): string {
  const packetDir = randomizeFixtures('packet');
  t.after(() => rmSync(packetDir, { recursive: true, force: true }));
  const packetPath = writePacketFile(packetDir, packetText);
  const result = runAtomicCli(['enroll', '--file', packetPath], { home });
  assert.equal(result.status, 0, `enroll must succeed:\n${result.stdout}\n${result.stderr}`);
  const profilePath = path.join(home, 'device-profile.json');
  assert.ok(existsSync(profilePath), 'the profile file must exist after enrollment');
  return profilePath;
}

/** Scans output for the secret itself and a 12-letter interior chunk. */
function assertSecretAbsent(text: string, secret: string): void {
  assert.ok(text.length > 0);
  assert.ok(!text.includes(secret), 'full secret leaked');
  const interior = secret.slice(12, 24);
  assert.ok(!text.toUpperCase().includes(interior), 'interior secret chunk leaked');
}

function assertCleanOutput(result: CliResult, secret: string): void {
  assertSecretAbsent(`${result.stdout}\n${result.stderr}`, secret);
}

function currentWindowsSid(): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stderr}`);
  const sid = (result.stdout ?? '').trim();
  assert.match(sid, /^S-1-\d(-\d+)+$/);
  return sid;
}

type DaclObservation = {
  protected: boolean;
  rules: Array<{ type: string; inherited: boolean; rights: string; identity: string }>;
};

/** Reads a DACL with Get-Acl inside one PowerShell child (test-side). */
function readWindowsDacl(target: string): DaclObservation {
  const escaped = target.replace(/'/g, "''");
  const script = `$acl = Get-Acl -LiteralPath '${escaped}'
[pscustomobject]@{
  protected = [bool]$acl.AreAccessRulesProtected
  rules = @($acl.Access | ForEach-Object {
    try { $identity = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $identity = 'UNRESOLVED' }
    [pscustomobject]@{ type = $_.AccessControlType.ToString(); inherited = [bool]$_.IsInherited; rights = $_.FileSystemRights.ToString(); identity = $identity }
  })
} | ConvertTo-Json -Depth 4`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stderr}`);
  return JSON.parse(result.stdout ?? '{}') as DaclObservation;
}

function parsePayBody(stdout: string): { code: string; expiresAtEpochMs: number } {
  const lines = stdout.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^[A-Z0-9]{4}-[A-Z0-9]{6}$/, `unexpected pay output: ${stdout}`);
  const expiryLine = lines.find((line) => line.startsWith('Code expires at:'));
  assert.ok(expiryLine, 'pay must state the code expiry instant');
  const isoMatch = /Code expires at: (\S+)/.exec(expiryLine);
  assert.ok(isoMatch);
  const expiresAtEpochMs = Date.parse(isoMatch[1]);
  assert.ok(Number.isSafeInteger(expiresAtEpochMs));
  return { code: lines[0].split('-').at(-1) ?? '', expiresAtEpochMs };
}

function codeForStep(secret: string, expiresAtEpochMs: number): string {
  const timeStep = expiresAtEpochMs / TOTP_TIME_STEP_MS - 1;
  return generateTotp(secret, timeStep * TOTP_TIME_STEP_MS).code;
}

test('automatic setup creates and reuses a protected random JSON profile', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('auto-setup');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const before = Date.now();
  const first = runAtomicCli(['setup'], { home });
  const after = Date.now();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const profilePath = path.join(home, 'device-profile.json');
  const original = readFileSync(profilePath, 'utf8');
  const profile = JSON.parse(original) as Record<string, unknown>;
  assert.match(String(profile.prefix), /^[A-Z0-9]{4}$/);
  assert.match(String(profile.secret), /^[A-Z2-7]{32}$/);
  assert.equal(profile.version, 2);
  assert.equal(profile.algorithm, 'SHA1');
  assert.equal(profile.codeEncoding, 'BASE36-HOTP31');
  assert.equal(profile.codeLength, 6);
  assert.equal(profile.periodSeconds, 30);
  assert.equal(profile.revoked, false);
  const lifetime = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Number(profile.expiresAtEpochMs) >= before + lifetime);
  assert.ok(Number(profile.expiresAtEpochMs) <= after + lifetime);
  assertCleanOutput(first, String(profile.secret));
  assert.match(first.stdout, /backend must register/i);

  const second = runAtomicCli(['setup'], { home, guard: true });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(readFileSync(profilePath, 'utf8'), original, 'setup must reuse the same identity');
  assertCleanOutput(second, String(profile.secret));
  const pay = runAtomicCli(['pay'], { home, guard: true });
  assert.equal(pay.status, 0, `${pay.stdout}\n${pay.stderr}`);
  const { code, expiresAtEpochMs } = parsePayBody(pay.stdout);
  assert.equal(code, codeForStep(String(profile.secret), expiresAtEpochMs));
  assertCleanOutput(pay, String(profile.secret));
});

test('automatic setup does not replace expired, revoked or corrupt profiles', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('auto-fail-closed');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify(makePacket()));
  const original = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
  for (const [text, expected] of [
    [JSON.stringify({ ...original, expiresAtEpochMs: Date.now() - 1 }), /expired/],
    [JSON.stringify({ ...original, revoked: true }), /revoked/],
    ['{corrupt', /corrupt/],
  ] as const) {
    writeFileSync(profilePath, text, 'utf8');
    const result = runAtomicCli(['setup'], { home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(readFileSync(profilePath, 'utf8'), text, 'existing profile must not be replaced');
  }
});

test('legacy profile migration keeps the secret and expiry while upgrading the format', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('legacy-upgrade');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial = runAtomicCli(['setup'], { home });
  assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`);
  const profilePath = path.join(home, 'device-profile.json');
  const before = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
  const legacy = {
    version: 1, prefix: '4CFQYNN7ZB', secret: before.secret, algorithm: 'SHA1',
    digits: 6, periodSeconds: 30, expiresAtEpochMs: before.expiresAtEpochMs, revoked: false,
  };
  writeFileSync(profilePath, JSON.stringify(legacy), 'utf8');
  const upgraded = runAtomicCli(['setup'], { home, guard: true });
  assert.equal(upgraded.status, 0, `${upgraded.stdout}\n${upgraded.stderr}`);
  assertCleanOutput(upgraded, String(before.secret));
  assert.match(upgraded.stdout, /updated prefix and code format/);
  const updatedText = readFileSync(profilePath, 'utf8');
  const updated = JSON.parse(updatedText) as Record<string, unknown>;
  assert.equal(updated.version, 2);
  assert.equal(updated.prefix, '4CFQ');
  assert.equal(updated.secret, before.secret);
  assert.equal(updated.expiresAtEpochMs, before.expiresAtEpochMs);
  assert.equal(updated.codeEncoding, 'BASE36-HOTP31');
  assert.equal(updated.codeLength, 6);
  const pay = runAtomicCli(['pay'], { home, guard: true });
  assert.equal(pay.status, 0, `${pay.stdout}\n${pay.stderr}`);
  assert.match(pay.stdout, /^4CFQ-[A-Z0-9]{6}/);
  const again = runAtomicCli(['setup'], { home });
  assert.equal(again.status, 0);
  assert.equal(readFileSync(profilePath, 'utf8'), updatedText, 'repeated setup must not change identity');
});

test('expired legacy profiles are not upgraded or replaced', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('legacy-expired');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial = runAtomicCli(['setup'], { home });
  assert.equal(initial.status, 0);
  const profilePath = path.join(home, 'device-profile.json');
  const current = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
  const legacy = JSON.stringify({
    version: 1, prefix: '4CFQYNN7ZB', secret: current.secret, algorithm: 'SHA1',
    digits: 6, periodSeconds: 30, expiresAtEpochMs: Date.now() - 1, revoked: false,
  });
  writeFileSync(profilePath, legacy, 'utf8');
  const result = runAtomicCli(['setup'], { home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expired/);
  assert.equal(readFileSync(profilePath, 'utf8'), legacy);
});

test('Windows batch pay does not create an unregistered profile', { timeout: 300_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.skip('batch launcher applies only on Windows');
    return;
  }
  const home = randomizeFixtures('batch-auto');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync('cmd.exe', ['/d', '/c', 'atomic.bat', 'pay'], {
    cwd: path.join(backendRoot, '..'),
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ATOMIC_DEVICE_HOME: home },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /atomic connect/);
  assert.equal(existsSync(path.join(home, 'device-profile.json')), false);
});

test('pay refuses an unregistered local demo profile by default', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('local-demo-disabled');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(runAtomicCli(['setup'], { home }).status, 0);
  const result = spawnSync(process.execPath, [cliPath, 'pay'], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ATOMIC_DEVICE_HOME: home, ATOMIC_ALLOW_LOCAL_DEMO: '' },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /atomic connect/);
  assert.equal(result.stdout, '');
});

test('atomic pay prints the current valid code and never claims payment success', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('pay-happy');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret }), null, 2));

  const pay = runAtomicCli(['pay'], { home });
  assert.equal(pay.status, 0, `${pay.stdout}\n${pay.stderr}`);
  assertCleanOutput(pay, secret);
  const { code, expiresAtEpochMs } = parsePayBody(pay.stdout);
  assert.ok(Number.isSafeInteger(expiresAtEpochMs / TOTP_TIME_STEP_MS - 1), 'expiry must be step-aligned');
  // Independent domain cross-check: the CLI's code equals generateTotp for
  // the step the CLI's local clock was in.
  assert.equal(code, codeForStep(secret, expiresAtEpochMs), `CLI code ${code} must match the domain generator`);
  assert.match(pay.stdout, /not a payment/);
  assert.match(pay.stdout, /not a receipt/);
});

test('repeated pay inside one time step prints the identical code', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('pay-repeat');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret }), null, 2));

  const first = parsePayBody(runAtomicCli(['pay'], { home }).stdout);
  const second = parsePayBody(runAtomicCli(['pay'], { home }).stdout);
  if (first.expiresAtEpochMs === second.expiresAtEpochMs) {
    assert.equal(first.code, second.code, 'same-step pays must be stable');
  } else {
    // Boundary crossed between runs; each must still be valid for its step.
    assert.equal(first.code, codeForStep(secret, first.expiresAtEpochMs));
    assert.equal(second.code, codeForStep(secret, second.expiresAtEpochMs));
  }
});

test('atomic status reports local enrollment facts without balance or grant claims', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('status-happy');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret }), null, 2));

  const status = runAtomicCli(['status'], { home });
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assertCleanOutput(status, secret);
  assert.match(status.stdout, /Enrolled/);
  assert.match(status.stdout, /Prefix: 4RTW/);
  assert.match(status.stdout, /Local enrollment expires at:/);
  // The honesty contract: explicitly negated claims, no balance display.
  assert.match(status.stdout, /does not show wallet balance/);
  assert.match(status.stdout, /provider grant validity/);
  assert.doesNotMatch(status.stdout, /balance:/i);
});

test('status before enrollment reports Not enrolled; pay fails closed', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('status-empty');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const status = runAtomicCli(['status'], { home });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Not enrolled/);
  const pay = runAtomicCli(['pay'], { home });
  assert.equal(pay.status, 1);
  assert.match(pay.stderr, /No local device profile/);
});

/** Fail-closed matrix: each bad packet is refused and NOTHING is written. */
const BAD_PACKETS: ReadonlyArray<{ name: string; packet: Record<string, unknown>; expect?: RegExp }> = [
  { name: 'unsupported version', packet: makePacket({ version: 3 }), expect: /version is unsupported/ },
  { name: 'missing code length', packet: packetOverridesWithMutation((p) => { delete p.codeLength; }) },
  { name: 'unknown extra field', packet: { ...makePacket(), nickname: 'leeroy' } },
  { name: 'missing prefix', packet: packetOverridesWithMutation((p) => { delete p.prefix; }) },
  { name: 'lowercase prefix', packet: makePacket({ prefix: '4rtw' }) },
  { name: 'trailing newline in prefix', packet: makePacket({ prefix: '4RTW\n' }) },
  { name: 'short prefix', packet: makePacket({ prefix: '4RT' }) },
  { name: 'overlong prefix', packet: makePacket({ prefix: '4RTWX' }) },
  { name: 'unsupported algorithm', packet: makePacket({ algorithm: 'SHA256' }) },
  { name: 'unsupported code length', packet: makePacket({ codeLength: 8 }) },
  { name: 'unsupported code encoding', packet: makePacket({ codeEncoding: 'DECIMAL' }) },
  { name: 'unsupported period', packet: makePacket({ periodSeconds: 60 }) },
  { name: 'expired packet', packet: makePacket({ expiresAtEpochMs: Date.now() - 1000 }), expect: /already expired/ },
  { name: 'locally known revoked', packet: makePacket({ revoked: true }), expect: /revoked/ },
  // 26 letters decode to only 128 bits: below the 160-bit CLI floor.
  { name: 'sub-160-bit secret', packet: makePacket({ secret: randomSecretLetters(26) }) },
  { name: 'whitespace in secret', packet: makePacket({ secret: `${randomSecretLetters(20)} ${randomSecretLetters(12)}` }) },
  { name: 'trailing newline in secret', packet: makePacket({ secret: `${randomSecretLetters(32)}\n` }) },
  { name: 'non-ASCII secret', packet: makePacket({ secret: `${randomSecretLetters(31)}ı` }) },
  { name: 'base32hex digits in secret', packet: makePacket({ secret: `${randomSecretLetters(29)}081` }) },
  { name: 'non-canonical padding', packet: makePacket({ secret: `${randomSecretLetters(32)}========` }) },
  { name: 'fractional expiry', packet: makePacket({ expiresAtEpochMs: 1.5 }) },
  { name: 'unsafe-integer expiry', packet: makePacket({ expiresAtEpochMs: 2 ** 54 }) },
  { name: 'expiry outside the Date range', packet: makePacket({ expiresAtEpochMs: Number.MAX_SAFE_INTEGER }) },
  { name: 'negative expiry', packet: makePacket({ expiresAtEpochMs: -1 }) },
];

test('enroll fails closed on every malformed packet and writes nothing', { timeout: 300_000 }, (t) => {
  for (const { name, packet, expect } of BAD_PACKETS) {
    const home = randomizeFixtures('enroll-bad');
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const packetDir = randomizeFixtures('packet-bad');
    t.after(() => rmSync(packetDir, { recursive: true, force: true }));
    const packetPath = writePacketFile(packetDir, JSON.stringify(packet, null, 2));
    const result = runAtomicCli(['enroll', '--file', packetPath], { home });
    assert.equal(result.status, 1, `${name}: enroll must fail closed`);
    assert.equal(result.stdout, '', `${name}: no stdout on failure`);
    assert.ok(result.stderr.length > 0, `${name}: failure must be explained`);
    if (expect) assert.match(result.stderr, expect, name);
    assert.equal(existsSync(path.join(home, 'device-profile.json')), false, `${name}: nothing was written`);
    const pay = runAtomicCli(['pay'], { home });
    assert.equal(pay.status, 1, `${name}: pay without a profile must fail`);
  }
});

test('import accepts a lowercase, canonically padded 21-byte Base32 secret', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('padded');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGE======'.toLowerCase();
  enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret })));
  const pay = runAtomicCli(['pay'], { home });
  assert.equal(pay.status, 0, `${pay.stdout}\n${pay.stderr}`);
  assertCleanOutput(pay, secret);
  const { code, expiresAtEpochMs } = parsePayBody(pay.stdout);
  assert.equal(code, codeForStep(secret, expiresAtEpochMs));
});

test('import accepts a single Windows UTF-8 BOM and rejects a duplicate BOM', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('bom');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const packet = JSON.stringify(makePacket());
  const badHome = randomizeFixtures('double-bom');
  t.after(() => rmSync(badHome, { recursive: true, force: true }));
  const packetDir = randomizeFixtures('bom-packet');
  t.after(() => rmSync(packetDir, { recursive: true, force: true }));
  const packetPath = writePacketFile(packetDir, `\uFEFF\uFEFF${packet}`);
  assert.equal(runAtomicCli(['enroll', '--file', packetPath], { home: badHome }).status, 1);
  enrollWithPacketFile(t, home, `\uFEFF${packet}`);
  assert.equal(runAtomicCli(['pay'], { home }).status, 0);
});

test('enroll fails closed on unreadable or corrupt packet files', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('enroll-corrupt');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const missing = runAtomicCli(['enroll', '--file', path.join(home, 'missing.json')], { home });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not read the enrollment packet file/);

  const packetDir = randomizeFixtures('packet-corrupt');
  t.after(() => rmSync(packetDir, { recursive: true, force: true }));
  const corrupted = writePacketFile(packetDir, `${JSON.stringify(makePacket(), null, 2)}trailing garbage`);
  const result = runAtomicCli(['enroll', '--file', corrupted], { home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /corrupt/);
  assert.equal(existsSync(path.join(home, 'device-profile.json')), false);
});

test('pay fails closed when the stored profile is tampered with', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('pay-tamper');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret }), null, 2));
  const original = readFileSync(profilePath, 'utf8');
  const base = JSON.parse(original) as Record<string, unknown>;

  const tamperAndPay = (text: string, expected: RegExp) => {
    writeFileSync(profilePath, text, 'utf8');
    const pay = runAtomicCli(['pay'], { home });
    assert.equal(pay.status, 1);
    assert.match(pay.stderr, expected);
    assertCleanOutput(pay, secret);
  };
  tamperAndPay(JSON.stringify({ ...base, expiresAtEpochMs: Date.now() - 1000 }), /locally expired/);
  tamperAndPay(JSON.stringify({ ...base, revoked: true }), /revoked/);
  tamperAndPay(`${original}garbage`, /corrupt/);
  tamperAndPay(JSON.stringify({ ...base, extra: 1 }), /missing, mistyped, or unsupported/);

  // Locally known revoked is also invisible to status as an active device.
  writeFileSync(profilePath, JSON.stringify({ ...base, revoked: true }), 'utf8');
  const status = runAtomicCli(['status'], { home });
  assert.equal(status.status, 1);
  assert.doesNotMatch(status.stdout, /Enrolled/);
  assert.match(status.stderr, /revoked/);
});

test('overwriting an existing profile is refused and the file is untouched', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('enroll-once');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify(makePacket({ secret }), null, 2));
  const original = readFileSync(profilePath, 'utf8');

  const packetDir = randomizeFixtures('packet-once');
  t.after(() => rmSync(packetDir, { recursive: true, force: true }));
  const result = runAtomicCli(
    ['enroll', '--file', writePacketFile(packetDir, JSON.stringify({ ...makePacket(), secret: randomSecretLetters() }, null, 2))],
    { home },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(profilePath, 'utf8'), original, 'the stored profile must not change');
});

test('ATOMIC_DEVICE_HOME override isolates stores; unusable homes are refused', { timeout: 300_000 }, (t) => {
  const homeA = randomizeFixtures('home-a');
  t.after(() => rmSync(homeA, { recursive: true, force: true }));
  const homeB = randomizeFixtures('home-b');
  t.after(() => rmSync(homeB, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, homeA, JSON.stringify({ ...makePacket(), secret }, null, 2));

  const foreignPay = runAtomicCli(['pay'], { home: homeB });
  assert.equal(foreignPay.status, 1);
  assert.match(foreignPay.stderr, /No local device profile/);

  // A directory holding unrelated files is not a dedicated device directory.
  const crowded = randomizeFixtures('home-crowded');
  t.after(() => rmSync(crowded, { recursive: true, force: true }));
  const unrelated = path.join(crowded, 'unrelated.txt');
  writeFileSync(unrelated, 'hello', 'utf8');
  const packetDir = randomizeFixtures('packet-crowded');
  t.after(() => rmSync(packetDir, { recursive: true, force: true }));
  const rejected = runAtomicCli(
    ['enroll', '--file', writePacketFile(packetDir, JSON.stringify({ ...makePacket(), secret }, null, 2))],
    { home: crowded },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /dedicated directory/);
  // ...and it must remain completely unaltered (no chmod/ACL, no writes).
  assert.equal(readFileSync(unrelated, 'utf8'), 'hello');
  assert.equal(existsSync(path.join(crowded, 'device-profile.json')), false);

  // Relative override paths are rejected, never silently interpreted.
  const packetDir2 = randomizeFixtures('packet-rel');
  t.after(() => rmSync(packetDir2, { recursive: true, force: true }));
  const relative = runAtomicCli(
    ['enroll', '--file', writePacketFile(packetDir2, JSON.stringify({ ...makePacket(), secret }, null, 2))],
    { home: path.join('relative', 'home') },
  );
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /absolute path/);
});

test('profile at-rest protection: POSIX 0700/0600 modes', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('protection-posix');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify({ ...makePacket(), secret }, null, 2));
  if (process.platform === 'win32') {
    // POSIX modes are not authoritative on Windows; the ACL exercise covers it.
    t.skip('POSIX mode checks apply only off-Windows');
    return;
  }
  assert.equal(lstatSync(home).mode & 0o777, 0o700, 'device directory must be 0700');
  assert.equal(lstatSync(path.join(home, 'device-profile.json')).mode & 0o777, 0o600, 'profile file must be 0600');
});

test('profile at-rest protection: real Windows user-only ACL (SID-granted, inheritance off)', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('protection-acl');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify({ ...makePacket(), secret }, null, 2));
  if (process.platform !== 'win32') {
    t.skip('Windows ACL exercise applies only on Windows');
    return;
  }
  const sid = currentWindowsSid();
  for (const [target, kind] of [[home, 'dir'], [profilePath, 'file']] as const) {
    const acl = readWindowsDacl(target);
    assert.equal(acl.protected, true, `${kind}: inheritance must be disabled`);
    assert.equal(acl.rules.length, 1, `${kind}: every other explicit ACE must be removed`);
    const rule = acl.rules[0];
    assert.equal(rule.type, 'Allow', `${kind}: the single ACE must allow`);
    assert.equal(rule.rights, 'FullControl', `${kind}: the single ACE must be FullControl`);
    assert.equal(rule.inherited, false, `${kind}: nothing may be inherited`);
    assert.equal(rule.identity, sid, `${kind}: the single ACE must reference the current user's SID`);
  }
});

test('Windows refuses a profile if another principal gains access', { timeout: 300_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows ACL exercise applies only on Windows');
    return;
  }
  const home = randomizeFixtures('acl-tamper');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify(makePacket()));
  const grant = spawnSync('icacls.exe', [profilePath, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
  assert.equal(grant.status, 0, `${grant.stdout}\n${grant.stderr}`);
  const pay = runAtomicCli(['pay'], { home });
  assert.equal(pay.status, 1);
  assert.match(pay.stderr, /protection is no longer intact/);
});

test('pay and status succeed inside the process network-API guard', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('guard-offline');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify({ ...makePacket(), secret }, null, 2));

  const pay = runAtomicCli(['pay'], { home, guard: true });
  assert.equal(pay.status, 0, `${pay.stdout}\n${pay.stderr}`);
  assert.ok(!pay.stderr.includes('atomic guard'), 'the pay path must not touch any network API');
  parsePayBody(pay.stdout);
  assertCleanOutput(pay, secret);

  const status = runAtomicCli(['status'], { home, guard: true });
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.ok(!status.stderr.includes('atomic guard'));
});

test('the network-API guard actually fires (tripwire sanity, not an OS airgap)', { timeout: 300_000 }, () => {
  const result = spawnSync(
    process.execPath,
    ['--require', guardPath, '-e',
      "require('node:https').get('https://atomic-demo.invalid');"],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.notEqual(result.status, 0, 'a guarded network call must fail closed');
  assert.match(`${result.stderr ?? ''}`, /atomic guard/);
});

test('secret material never appears in enrollment, pay, or status output', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('non-disclosure');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  enrollWithPacketFile(t, home, JSON.stringify({ ...makePacket(), secret }, null, 2));
  assertCleanOutput(runAtomicCli(['pay'], { home }), secret);
  assertCleanOutput(runAtomicCli(['status'], { home }), secret);
  // The stored profile file itself is the only place the secret may exist.
  void readFileSync(path.join(home, 'device-profile.json'), 'utf8');
});

test('CLI argument handling: usage, unknown commands, and exit codes', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('usage');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const noCommand = runAtomicCli([], { home });
  assert.equal(noCommand.status, 1);
  assert.match(noCommand.stderr, /Usage:/);

  const help = runAtomicCli(['--help'], { home });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const unknown = runAtomicCli(['nonsense'], { home });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);

  const missingFile = runAtomicCli(['enroll'], { home });
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stderr, /Usage:/);
  assert.equal(runAtomicCli(['status', '--unexpected'], { home }).status, 1);
});

test('symlinked profile targets are rejected (fail closed)', { timeout: 300_000 }, (t) => {
  const home = randomizeFixtures('symlink');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = randomSecretLetters();
  const profilePath = enrollWithPacketFile(t, home, JSON.stringify({ ...makePacket(), secret }, null, 2));
  const outside = randomizeFixtures('symlink-outside');
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  let symlinkCreated = false;
  try {
    const retained = readFileSync(profilePath, 'utf8');
    const decoy = path.join(outside, 'leaked-copy.json');
    writeFileSync(decoy, retained, 'utf8');
    unlinkSync(profilePath);
    symlinkSync(decoy, profilePath);
    symlinkCreated = true;
  } catch {
    t.skip('symlink creation is unavailable without privilege on this host');
  }
  if (!symlinkCreated) {
    // lstat already failed to see a link; nothing more to do here.
    return;
  }
  const pay = runAtomicCli(['pay'], { home });
  assert.equal(pay.status, 1, 'a symlinked profile file must never load');
  assert.match(`${pay.stderr}${pay.stdout}`, /symlink/);
  const status = runAtomicCli(['status'], { home });
  assert.equal(status.status, 1, 'status also fails closed on a symlinked profile');
});
