import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { enrollWithApi } from "../src/cli/api-enrollment";
import { saveDeviceProfile } from "../src/cli/local-device-store";
import { generateDecimalTotp } from "../src/domain/payment-engine/totp";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // public RFC 6238 vector
const authorizationId = "3321ed7d-9a34-4d36-98ac-2c1192cd1b17";
const token = "test-token-not-a-secret";
const packet = () => ({
  version: 1, prefix: "ABC234", secret, algorithm: "SHA1", digits: 6,
  periodSeconds: 30, expiresAtEpochMs: Date.now() + 600_000, revoked: false,
});
const grant = () => ({
  authorizationId, status: "ACTIVE", authoritySource: "PROVIDER",
  payerWalletAddress: "https://example.test/payer", validUntil: new Date(Date.now() + 600_000).toISOString(),
  remaining: { value: "500", assetCode: "EUR", assetScale: 2 },
});

function homeFor(t: TestContext): string {
  const harnessTemp = path.join(tmpdir(), "opencode");
  const parent = process.platform === "win32" && existsSync(harnessTemp) ? harnessTemp : tmpdir();
  const home = mkdtempSync(path.join(parent, "atomic-api-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  return `http://127.0.0.1:${address.port}`;
}

test("API login and one-time enrollment produce a protected profile usable by offline pay", { timeout: 120_000 }, async (t) => {
  const home = homeFor(t);
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const route = `${req.method} ${req.url}`;
    seen.push(route);
    res.setHeader("content-type", "application/json");
    if (route === "POST /api/auth/login") {
      assert.deepEqual(JSON.parse(body), { email: "payer@example.test", password: "test-password" });
      res.end(JSON.stringify({ token }));
    } else if (route === "GET /api/payment-grants") {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.end(JSON.stringify({ grants: [grant()] }));
    } else if (route === "POST /api/devices/totp/enroll") {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.deepEqual(JSON.parse(body), { authorizationId, deviceName: "Atomic CLI" });
      res.statusCode = 201;
      res.end(JSON.stringify(packet()));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const enrolled = await enrollWithApi({
    baseUrl, email: "payer@example.test", password: "test-password", deviceHome: home,
    chooseGrant: async () => { throw new Error("A single grant should be selected automatically"); },
  });
  assert.equal(enrolled.prefix, "ABC234");
  assert.deepEqual(seen, ["POST /api/auth/login", "GET /api/payment-grants", "POST /api/devices/totp/enroll"]);
  assert.equal(JSON.parse(readFileSync(path.join(home, "device-profile.json"), "utf8")).version, 1);

  const cli = path.resolve(__dirname, "../src/commands/atomic.ts");
  const guard = path.resolve(__dirname, "atomic-network-guard.cjs");
  const result = spawnSync(process.execPath, ["--require", guard, "--import", "tsx", cli, "pay"], {
    encoding: "utf8", timeout: 90_000,
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ATOMIC_API_DEVICE_HOME: home },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const firstLine = result.stdout.split(/\r?\n/)[0];
  assert.match(firstLine, /^ABC234-[0-9]{6}$/);
  const expiry = /Code expires at: (\S+)/.exec(result.stdout);
  assert.ok(expiry);
  assert.equal(firstLine, `ABC234-${generateDecimalTotp(secret, Date.parse(expiry[1]) - 1).code}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  for (const [seconds, expected] of [
    [59, "287082"], [1_111_111_109, "081804"], [1_111_111_111, "050471"],
    [1_234_567_890, "005924"], [2_000_000_000, "279037"], [20_000_000_000, "353130"],
  ] as const) {
    assert.equal(generateDecimalTotp(secret, seconds * 1000).code, expected);
  }
});

test("interactive connect logs in without echoing the password", { timeout: 120_000 }, async (t) => {
  const home = homeFor(t);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/login") {
      assert.deepEqual(JSON.parse(body), { email: "payer@example.test", password: "hidden-test-password" });
      res.end(JSON.stringify({ token }));
    } else if (req.url === "/api/payment-grants") {
      res.end(JSON.stringify({ grants: [grant()] }));
    } else if (req.url === "/api/devices/totp/enroll") {
      res.statusCode = 201;
      res.end(JSON.stringify(packet()));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const cli = path.resolve(__dirname, "../src/commands/atomic.ts");
  const fixture = path.resolve(__dirname, "atomic-interactive-fixture.cjs");
  const child = spawn(process.execPath, ["--require", fixture, "--import", "tsx", cli, "connect", "--api-url", baseUrl], {
    env: { ...process.env, ATOMIC_API_DEVICE_HOME: home },
    cwd: path.resolve(__dirname, ".."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  let emailSent = false;
  let passwordSent = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    if (!emailSent && stdout.includes("Email:")) {
      emailSent = true;
      child.stdin.write("payer@example.test\n");
    }
    if (!passwordSent && stdout.includes("Password:")) {
      passwordSent = true;
      child.stdin.write("hidden-test-password\n");
    }
  });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exit, 0, `${stdout}\n${stderr}`);
  assert.ok(emailSent && passwordSent);
  assert.match(stdout, /Device enrolled through the API/);
  assert.ok(!`${stdout}${stderr}`.includes("hidden-test-password"));
  assert.ok(!`${stdout}${stderr}`.includes(secret));
  assert.ok(!`${stdout}${stderr}`.includes(token));
});

test("no approved grant or malformed enrollment packet fails without a local profile", { timeout: 120_000 }, async (t) => {
  const home = homeFor(t);
  let enrollmentCalls = 0;
  let grants: unknown[] = [{ ...grant(), authoritySource: "DEMO_PLACEHOLDER" }];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/auth/login")) return Response.json({ token });
    if (url.endsWith("/api/payment-grants")) return Response.json({ grants });
    enrollmentCalls += 1;
    return Response.json({ ...packet(), extra: "unexpected" }, { status: 201 });
  };
  const options = {
    baseUrl: "http://127.0.0.1:3000", email: "payer@example.test", password: "test-password",
    deviceHome: home, chooseGrant: async () => 0, fetch: fakeFetch,
  };
  await assert.rejects(enrollWithApi(options), /No active provider grant/);
  assert.equal(enrollmentCalls, 0);
  grants = [grant()];
  await assert.rejects(enrollWithApi(options), /Enrollment may already exist/);
  assert.equal(enrollmentCalls, 1);
  assert.throws(() => readFileSync(path.join(home, "device-profile.json"), "utf8"));
});

test("existing profile is not overwritten and enrollment is never repeated automatically", { timeout: 120_000 }, async (t) => {
  const home = homeFor(t);
  let enrollmentCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/auth/login")) return Response.json({ token });
    if (url.endsWith("/api/payment-grants")) return Response.json({ grants: [grant()] });
    enrollmentCalls += 1;
    return Response.json(packet(), { status: 201 });
  };
  const options = {
    baseUrl: "http://127.0.0.1:3000", email: "payer@example.test", password: "test-password",
    deviceHome: home, chooseGrant: async () => 0, fetch: fakeFetch,
  };
  await enrollWithApi(options);
  const original = readFileSync(path.join(home, "device-profile.json"), "utf8");
  await assert.rejects(enrollWithApi(options), /refusing to overwrite/);
  assert.equal(enrollmentCalls, 1);
  assert.equal(readFileSync(path.join(home, "device-profile.json"), "utf8"), original);
});

test("pay refuses an unregistered local demo profile by default", { timeout: 120_000 }, (t) => {
  const home = homeFor(t);
  const apiHome = homeFor(t);
  saveDeviceProfile(home, {
    version: 2, prefix: "4RTW", secret, algorithm: "SHA1", codeEncoding: "BASE36-HOTP31",
    codeLength: 6, periodSeconds: 30, expiresAtEpochMs: Date.now() + 600_000, revoked: false,
  });
  const cli = path.resolve(__dirname, "../src/commands/atomic.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "pay"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, ATOMIC_DEVICE_HOME: home, ATOMIC_API_DEVICE_HOME: apiHome, ATOMIC_ALLOW_LOCAL_DEMO: "" },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /atomic connect/);
  assert.equal(result.stdout, "");
});
