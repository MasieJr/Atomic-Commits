import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import bcrypt from 'bcrypt';
import { Pool } from 'pg';

import { createApp } from '../src/app';

async function createFixture(t: TestContext) {
  const user = { id: 1, name: 'Test User', email: 'user@example.test' };
  const hash = t.mock.method(bcrypt, 'hash', async () => 'test-password-hash');
  const compare = t.mock.method(bcrypt, 'compare', async () => false);
  const query = t.mock.method(Pool.prototype, 'query', async (sql: string) => {
    if (sql.includes('INSERT INTO app_private.users')) {
      throw Object.assign(new Error('Duplicate test email'), {
        code: '23505',
        constraint: 'users_email_key',
      });
    }
    if (sql.includes('FROM app_private.users')) {
      return { rows: [{ ...user, password_hash: 'test-password-hash' }] };
    }
    return { rows: [] };
  });

  const { app, close } = createApp({
    databaseUrl: 'postgresql://test:test@127.0.0.1:1/test',
    jwtSecret: 'auth-rate-limit-test-secret-at-least-32-characters',
  });
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

  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json() as unknown,
    };
  }

  return { request, hash, compare, query, user };
}

test('login throttles before token creation and bcrypt, then allows login after reset', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { request, compare, query, user } = await createFixture(t);
  const credentials = { email: user.email, password: 'test-password' };

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await request('/api/auth/login', 'POST', credentials)).status, 401);
  }
  assert.equal(compare.mock.callCount(), 10);
  assert.equal(query.mock.callCount(), 10);

  const blocked = await request('/api/auth/login', 'POST', credentials);
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, {
    error: 'Too many authentication attempts. Please try again later.',
  });
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert(blocked.headers.has('ratelimit'));
  assert(blocked.headers.has('ratelimit-policy'));
  assert.equal(blocked.headers.get('x-ratelimit-limit'), null);
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert(retryAfter > 0 && retryAfter <= 900);
  assert.equal(compare.mock.callCount(), 10);
  assert.equal(query.mock.callCount(), 10);

  // Exhausting login attempts does not exhaust the separate registration budget.
  assert.equal((await request('/api/auth/register', 'POST', {
    name: user.name, ...credentials,
  })).status, 409);

  t.mock.timers.tick(15 * 60 * 1000 + 1);
  compare.mock.mockImplementation(async () => true);
  const recovered = await request('/api/auth/login', 'POST', credentials);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, {
    message: 'Login successful',
    user,
    token: (recovered.body as { token: string }).token,
  });
  assert.equal(typeof (recovered.body as { token?: unknown }).token, 'string');
  assert.equal(compare.mock.callCount(), 11);
});

test('registration throttles repeated attempts before hashing or accessing storage', async (t) => {
  const { request, hash, query, user } = await createFixture(t);
  const registration = { name: user.name, email: user.email, password: 'test-password' };

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request('/api/auth/register', 'POST', registration)).status, 409);
  }
  assert.equal(hash.mock.callCount(), 5);
  assert.equal(query.mock.callCount(), 5);

  assert.equal((await request('/api/auth/register', 'POST', registration)).status, 429);
  assert.equal(hash.mock.callCount(), 5);
  assert.equal(query.mock.callCount(), 5);
});

test('the shared auth limit protects token endpoints without limiting health checks', async (t) => {
  const { request, query, hash, compare } = await createFixture(t);

  /* every rejected request answers from the bearer check, no storage involved */
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal((await request('/api/auth/me')).status, 401);
  }
  assert.equal(query.mock.callCount(), 0);
  assert.equal((await request('/api/auth/me')).status, 429);
  assert.equal((await request('/api/auth/logout', 'POST')).status, 429);
  assert.equal(query.mock.callCount(), 0);

  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal(health.headers.get('ratelimit'), null);
  assert.equal(query.mock.callCount(), 0);
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(compare.mock.callCount(), 0);
});
