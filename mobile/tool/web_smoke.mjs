// Browser smoke test. Every API response and wallet in this script is simulated.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import pngjs from 'pngjs';

const root = path.resolve(process.argv[2] ?? 'build/web');
const browserPath = process.env.ATOMIC_BROWSER_EXE ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
  try {
    response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const appUrl = `http://127.0.0.1:${server.address().port}/`;
let registrations = 0;
let enrollments = 0;
let requests = 0;
let verifiedB = false;
let acceptedCode;
let debitCount = 0;
let redemptionAttempts = 0;

async function mockApi(page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoints = ['/auth/register', '/auth/login', '/wallet', '/payment-grants', '/devices/totp/enroll', '/merchant', '/offline-redemptions'];
    const endpoint = endpoints.find((path) => url.pathname.endsWith(path));
    if (!endpoint) {
      if (url.origin === new URL(appUrl).origin ||
          (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/flutter-canvaskit/')) ||
          (url.origin === 'https://fonts.gstatic.com' && url.pathname.startsWith('/s/'))) return route.continue();
      return route.abort();
    }
    requests++;
    const headers = { 'access-control-allow-origin': new URL(appUrl).origin,
      'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
      'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let result;
    let status = 200;
    if (endpoint === '/auth/register') {
      const input = request.postDataJSON();
      registrations++;
      status = 201;
      result = { message: 'Created', token: 'mock-b', user: { id: 2, name: input.name, email: input.email } };
    } else if (endpoint === '/auth/login') {
      result = { message: 'Login', token: 'mock-a', user: { id: 1, name: 'Mock User A', email: 'mock-a@example.test' } };
    } else if (endpoint === '/wallet') {
      const wallet = request.headers().authorization === 'Bearer mock-a'
        ? { address: 'https://ilp.interledger-test.dev/a', publicName: 'Mock A', assetCode: 'USD', assetScale: 2 }
        : verifiedB ? { address: 'https://ilp.interledger-test.dev/b', publicName: 'Mock B', assetCode: 'USD', assetScale: 2 } : null;
      result = { wallet };
    } else if (endpoint === '/payment-grants') {
      result = { grants: request.headers().authorization !== 'Bearer mock-a' ? [] : [{ authorizationId: '00000000-0000-4000-8000-000000000001', status: 'ACTIVE',
        authoritySource: 'PROVIDER', payerWalletAddress: 'https://ilp.interledger-test.dev/a',
        validUntil: new Date(Date.now() + 3_600_000).toISOString(), remaining: { value: '5000', assetCode: 'USD', assetScale: 2 } }] };
    } else if (endpoint === '/devices/totp/enroll') {
      enrollments++;
      status = 201;
      result = { version: 1, prefix: 'ABC234', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        algorithm: 'SHA1', digits: 6, periodSeconds: 30, expiresAtEpochMs: Date.now() + 3_600_000, revoked: false };
    } else if (endpoint === '/merchant') {
      assert.equal(request.headers().authorization, 'Bearer mock-b');
      assert.deepEqual(request.postDataJSON(), { displayName: 'Mock User B' });
      result = { merchantId: 'merchant-b', status: 'ACTIVE' };
    } else if (endpoint === '/offline-redemptions') {
      assert.equal(request.headers().authorization, 'Bearer mock-b');
      const body = request.postDataJSON();
      assert.match(request.headers()['idempotency-key'] ?? '', /^[a-f0-9]{32}$/);
      assert.equal(body.paymentCode, acceptedCode);
      assert.deepEqual(body.merchantReceive, { value: '1234', assetCode: 'USD', assetScale: 2 });
      redemptionAttempts++;
      if (redemptionAttempts === 1) {
        debitCount++;
        result = { paymentId: 'mock-payment', status: 'SUCCEEDED', payerName: 'Mock User A', merchantName: 'Mock User B',
          merchantReceiveRequested: body.merchantReceive, merchantReceivePaid: body.merchantReceive,
          payerDebitPaid: body.merchantReceive, providerIncomingRef: 'https://ilp.interledger-test.dev/incoming/mock' };
      } else {
        status = 409;
        result = { error: 'This payment code was already used.', code: 'CODE_ALREADY_USED' };
      }
    } else {
      status = 404;
      result = { error: 'Not found' };
    }
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(result) });
  });
}

function expectedCode(step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', '12345678901234567890').update(counter).digest();
  const offset = digest[19] & 15;
  return `ABC234-${((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')}`;
}

const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu'] });
try {
  const signup = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await mockApi(signup);
  await signup.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await signup.waitForTimeout(15_000);
  const phoneWidth = await signup.locator('#flutter-host').evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(phoneWidth, 430, 'The app must fill a phone-sized viewport.');
  await signup.mouse.click(215, 825);
  await signup.waitForTimeout(1_000);
  for (const [y, value] of [[430, 'Mock User B'], [510, 'mock-b@example.test'], [589, 'sample-password'], [669, 'sample-password']]) {
    await signup.mouse.click(150, y);
    await signup.keyboard.type(value);
  }
  await signup.mouse.click(210, 732);
  await signup.waitForURL((url) => url.hash === '#/wallet', { timeout: 30_000 });
  assert.equal(registrations, 1);
  assert.ok(signup.url().endsWith('#/wallet'), 'Registration must open wallet onboarding.');

  const payer = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await mockApi(payer);
  await payer.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await payer.waitForTimeout(15_000);
  await payer.mouse.click(215, 880);
  await payer.waitForTimeout(1_000);
  await payer.mouse.click(150, 430);
  await payer.keyboard.type('mock-a@example.test');
  await payer.mouse.click(150, 510);
  await payer.keyboard.type('sample-password');
  await payer.mouse.click(210, 584);
  await payer.waitForURL((url) => url.hash === '#/home', { timeout: 30_000 });
  assert.ok(payer.url().endsWith('#/home'), 'Login must open the signed-in dashboard.');
  await payer.mouse.click(100, 435);
  await payer.waitForTimeout(1_000);
  await payer.mouse.click(200, 202);
  await payer.waitForTimeout(1_000);
  await payer.mouse.click(160, 485);
  await payer.waitForTimeout(2_000);
  assert.equal(enrollments, 1);
  await payer.mouse.click(25, 28);
  await payer.waitForTimeout(1_000);
  await payer.context().setOffline(true);
  const beforeOffline = requests;
  await payer.mouse.click(100, 435);
  await payer.waitForTimeout(2_000);
  const image = pngjs.PNG.sync.read(await payer.screenshot());
  const qr = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.ok(qr, 'The offline payment screen must contain a readable QR code.');
  const current = Math.floor(Date.now() / 30_000);
  assert.ok([-1, 0, 1].map((drift) => expectedCode(current + drift)).includes(qr.data),
    'The QR must encode a valid code for the enrolled test profile.');
  assert.equal(requests - beforeOffline, 0, 'Opening the offline code screen must not call the API.');
  acceptedCode = qr.data;
  verifiedB = true;
  await signup.mouse.click(210, 375);
  await signup.waitForTimeout(2_000);
  await signup.mouse.click(54, 880);
  await signup.waitForTimeout(1_000);
  await signup.mouse.click(320, 435);
  await signup.waitForTimeout(1_000);
  await signup.mouse.click(200, 255);
  await signup.waitForTimeout(2_000);
  await signup.mouse.click(200, 218);
  await signup.waitForTimeout(2_000);
  await signup.mouse.click(120, 135);
  await signup.keyboard.type('12.34');
  await signup.mouse.click(120, 200);
  await signup.keyboard.type(acceptedCode);
  await signup.mouse.click(200, 270);
  await signup.waitForTimeout(2_000);
  assert.equal(redemptionAttempts, 1);
  assert.equal(debitCount, 1);
  await signup.locator('flt-semantics-placeholder').dispatchEvent('click');
  await signup.waitForTimeout(1_000);
  assert.ok(await signup.getByText('Payment confirmed', { exact: true }).count() > 0);
  await signup.mouse.click(210, 229);
  await signup.waitForTimeout(1_000);
  await signup.mouse.click(120, 135);
  await signup.keyboard.type('12.34');
  await signup.mouse.click(120, 200);
  await signup.keyboard.type(acceptedCode);
  await signup.mouse.click(200, 270);
  await signup.waitForTimeout(2_000);
  assert.equal(redemptionAttempts, 2);
  assert.equal(debitCount, 1);
  assert.ok(await signup.getByText('This payment code was already used.', { exact: true }).count() > 0);
  await signup.close();
  await payer.close();
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await mockApi(desktop);
  await desktop.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await desktop.waitForSelector('flutter-view', { state: 'attached', timeout: 45_000 });
  await desktop.waitForTimeout(3_000);
  const frame = await desktop.locator('.phone-frame').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, left: bounds.left, radius: getComputedStyle(element).borderRadius };
  });
  assert.ok(frame.width < 430 && frame.left > 0 && frame.radius !== '0px', 'Desktop must show a centered phone frame.');
  if (process.env.ATOMIC_SMOKE_SCREENSHOT) await desktop.screenshot({ path: process.env.ATOMIC_SMOKE_SCREENSHOT });
  console.log('PASS: simulated signup, offline QR, merchant checkout, replay rejection and phone frame in a real browser');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
