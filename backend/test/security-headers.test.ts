import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import { createApp } from '../src/app';

async function createFixture(t: TestContext) {
  const { app, close } = createApp();
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return (path: string, options?: RequestInit) => fetch(`${baseUrl}${path}`, options);
}

function assertSecurityHeaders(headers: Headers) {
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.match(headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(headers.get('x-powered-by'), null);
}

test('successful API responses, unavailable auth, and unknown routes carry security headers', async (t) => {
  const request = await createFixture(t);

  for (const { path, status, body } of [
    { path: '/health', status: 200, body: { status: 'ok' } },
    { path: '/api/auth/me', status: 503, body: { error: 'Authentication is not configured yet.' } },
    { path: '/missing-route', status: 404, body: { error: 'Not found' } },
  ]) {
    const response = await request(path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assertSecurityHeaders(response.headers);
  }
});

test('JSON parsing failures carry security headers and preserve their API errors', async (t) => {
  const request = await createFixture(t);

  for (const { body, status, error } of [
    { body: '{', status: 400, error: 'Request body must be valid JSON.' },
    {
      body: JSON.stringify({ padding: 'x'.repeat(11 * 1024) }),
      status: 413,
      error: 'Request body exceeds the 10 KB limit.',
    },
  ]) {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assertSecurityHeaders(response.headers);
  }
});
