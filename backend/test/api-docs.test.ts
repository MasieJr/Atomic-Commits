import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import { createApp } from '../src/app';

async function serve(t: TestContext, publicBaseUrl?: string) {
  const { app, close } = createApp({ publicBaseUrl });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`);
}

/* every public route must be documented; update both together */
const ROUTES = [
  ['get', '/health'],
  ['post', '/api/auth/register'],
  ['post', '/api/auth/login'],
  ['get', '/api/auth/me'],
  ['post', '/api/auth/logout'],
  ['post', '/api/payment-grants'],
  ['get', '/api/payment-grants'],
  ['get', '/api/payment-grants/approvals/{approvalId}'],
  ['get', '/api/payment-grants/{grantId}'],
  ['delete', '/api/payment-grants/{grantId}'],
  ['get', '/api/open-payments/callback/{approvalId}'],
  ['post', '/api/devices/totp/enroll'],
  ['get', '/api/devices/totp/{prefix}/status'],
  ['post', '/api/devices/totp/{prefix}/revoke'],
  ['post', '/api/offline-redemptions'],
  ['get', '/api/payments'],
  ['get', '/api/payments/{paymentId}'],
] as const;

test('the OpenAPI spec documents every route and points at the public server', async (t) => {
  const request = await serve(t, 'http://13.246.236.101:3000/');
  const res = await request('/api/openapi.json');
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, unknown>> };
  assert.equal(spec.openapi, '3.0.3');
  assert.deepEqual(spec.servers, [{ url: 'http://13.246.236.101:3000' }]);
  for (const [method, path] of ROUTES) {
    assert.ok(spec.paths[path]?.[method], `missing ${method.toUpperCase()} ${path}`);
  }
  const documented = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`));
  assert.equal(documented.length, ROUTES.length, `undocumented or stale entries: ${documented.join(', ')}`);
});

test('Swagger UI is served without upgrade-insecure-requests, and other routes keep the strict CSP', async (t) => {
  const request = await serve(t);
  const page = await request('/api/docs/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /swagger-ui/);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal((await request('/api/docs/swagger-ui-init.js')).status, 200);

  /* no spec server when PUBLIC_BASE_URL is unset: Try it out uses the same origin */
  const spec = (await (await request('/api/openapi.json')).json()) as { servers?: unknown };
  assert.equal(spec.servers, undefined);

  const health = await request('/health');
  assert.match(health.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/);
});
