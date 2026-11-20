import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';

import { createApp } from '../src/app';
import { ApiError } from '../src/errors/api-error';
import { createAccessTokenService } from '../src/services/tokens';

const secret = 'email-signup-test-secret-at-least-32-characters';

async function serve(t: TestContext, options: Parameters<typeof createApp>[0]) {
  const { app, close } = createApp(options);
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
  const base = `http://127.0.0.1:${address.port}/api/auth`;
  return async (path: string, body?: unknown) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
  };
}

test('status is present and fail closed when authentication is unconfigured', async (t) => {
  const request = await serve(t, {});
  const status = await request('/email-verification/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(status.body, { required: true, available: false });
  assert.equal((await request('/register', {})).status, 503);
});

test('status reports unavailable for missing email configuration or a down user store', async (t) => {
  const query = t.mock.method(Pool.prototype, 'query', async () => { throw new Error('down'); });
  const options = { databaseUrl: 'postgresql://test:test@127.0.0.1:1/test', jwtSecret: secret };
  const missing = await serve(t, options);
  assert.deepEqual((await missing('/email-verification/status')).body, { required: true, available: false });
  assert.equal(query.mock.callCount(), 0);
  const down = await serve(t, { ...options, emailVerification: { sendCode: async () => {}, verifyCode: async () => {} } });
  assert.deepEqual((await down('/email-verification/status')).body, { required: true, available: false });
});

test('provider outage fails closed even when status reports configured', async (t) => {
  const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
  const unavailable = async () => { throw new ApiError(503, 'Email unavailable', 'EMAIL_SERVICE_UNAVAILABLE'); };
  const request = await serve(t, {
    databaseUrl: 'postgresql://test:test@127.0.0.1:1/test', jwtSecret: secret,
    emailVerification: { sendCode: unavailable, verifyCode: unavailable },
  });
  assert.deepEqual((await request('/email-verification/status')).body, { required: true, available: true });
  assert.equal((await request('/email-code', { email: 'user@example.test' })).status, 503);
  assert.equal((await request('/register', { name: 'Test User', email: 'user@example.test', password: 'test-password', emailCode: '123456' })).status, 503);
  assert.equal(query.mock.callCount(), 1);
});

test('email signup verifies the requested code and survives refresh-store failure on signup and login', async (t) => {
  let stored: { id: number; name: string; email: string; password_hash: string } | undefined;
  let sentTo: string | undefined;
  t.mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('SELECT 1 FROM app_private.users')) return { rows: [] };
    if (sql.includes('INSERT INTO app_private.users')) {
      stored = { id: 7, name: String(values[0]), email: String(values[1]), password_hash: String(values[2]) };
      return { rows: [{ id: stored.id, name: stored.name, email: stored.email }] };
    }
    if (sql.includes('FROM app_private.users')) return { rows: stored && values[0] === stored.email ? [stored] : [] };
    if (sql.includes('refresh_tokens')) throw new Error('refresh store down');
    throw new Error(`Unexpected query: ${sql}`);
  });
  const request = await serve(t, {
    databaseUrl: 'postgresql://test:test@127.0.0.1:1/test', jwtSecret: secret,
    emailVerification: {
      sendCode: async (email) => { sentTo = email; },
      verifyCode: async (email, code) => {
        if (email !== sentTo || code !== '123456') throw new ApiError(400, 'Invalid code', 'EMAIL_CODE_INVALID');
      },
    },
  });
  assert.deepEqual((await request('/email-verification/status')).body, { required: true, available: true });
  const signup = { name: 'Test User', email: ' USER@Example.Test ', password: 'test-password' };
  assert.equal((await request('/email-code', { email: signup.email })).status, 202);
  assert.equal(sentTo, 'user@example.test');
  assert.equal((await request('/register', signup)).status, 400);
  assert.equal((await request('/register', { ...signup, emailCode: '999999' })).status, 400);
  assert.equal(stored, undefined);
  const registered = await request('/register', { ...signup, emailCode: '123456' });
  assert.equal(registered.status, 201);
  assert.equal(typeof registered.body.token, 'string');
  assert.equal(createAccessTokenService(secret).verify(String(registered.body.token)), 7);
  assert.equal('refreshToken' in registered.body, false);
  const login = await request('/login', { email: signup.email, password: signup.password });
  assert.equal(login.status, 200);
  assert.equal(createAccessTokenService(secret).verify(String(login.body.token)), 7);
  assert.equal('refreshToken' in login.body, false);
});
