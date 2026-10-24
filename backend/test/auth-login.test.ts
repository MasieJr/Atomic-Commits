import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';

import bcrypt from 'bcrypt';
import { Pool } from 'pg';

import { createApp } from '../src/app';
import { createAccessTokenService } from '../src/services/tokens';

async function createFixture(t: TestContext) {
  const user = { id: 1, name: 'Test User', email: 'user@example.test' };
  const password = 'correct-password';
  const passwordHash = await bcrypt.hash(password, 12);
  const compare = t.mock.method(bcrypt, 'compare');
  const hash = t.mock.method(bcrypt, 'hash');
  const query = t.mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM app_private.users') && values[0] === user.email) {
      return { rows: [{ ...user, password_hash: passwordHash }] };
    }
    return { rows: [] };
  });

  const jwtSecret = 'auth-login-test-secret-at-least-32-characters';
  const { app, close } = createApp({
    databaseUrl: 'postgresql://test:test@127.0.0.1:1/test',
    jwtSecret,
  });
  const tokens = createAccessTokenService(jwtSecret);
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
  const url = `http://127.0.0.1:${address.port}/api/auth/login`;

  async function login(email: string, suppliedPassword: string) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: suppliedPassword }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json() as unknown,
    };
  }

  return { login, compare, hash, query, user, password, passwordHash, tokens };
}

test('unknown email and wrong password both perform bcrypt work and return the same failure', async (t) => {
  const { login, compare, hash, query, user, passwordHash } = await createFixture(t);

  const wrongPassword = await login(user.email, 'incorrect-password');
  const unknownEmail = await login('missing@example.test', 'incorrect-password');

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(wrongPassword.body, { error: 'Invalid email or password' });
  assert.deepEqual(unknownEmail.body, wrongPassword.body);
  assert.equal(wrongPassword.headers.get('set-cookie'), null);
  assert.equal(compare.mock.callCount(), 2);
  assert.equal(compare.mock.calls[0].arguments[1], passwordHash);

  const dummyHash = compare.mock.calls[1].arguments[1];
  assert.equal(compare.mock.calls[1].arguments[0], 'incorrect-password');
  assert.equal(typeof dummyHash, 'string');
  assert.notEqual(dummyHash, passwordHash);
  assert.equal(bcrypt.getRounds(dummyHash), 12);
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(query.mock.callCount(), 2);
});

test('a successful dummy comparison cannot authenticate an unknown email', async (t) => {
  const { login, compare, query } = await createFixture(t);
  compare.mock.mockImplementation(async () => true);

  const response = await login('missing@example.test', 'any-valid-password');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Invalid email or password' });
  assert.equal(compare.mock.callCount(), 1);
  assert.equal(query.mock.callCount(), 1);
});

test('valid credentials still use the stored hash and return a bearer token', async (t) => {
  const { login, compare, hash, query, user, password, passwordHash, tokens } =
    await createFixture(t);

  const response = await login(`  ${user.email.toUpperCase()}  `, password);

  assert.equal(response.status, 200);
  const token = (response.body as { token?: unknown }).token;
  assert.equal(typeof token, 'string');
  /* header.payload.signature shape of an HS256 token signed with our secret */
  assert.match(token as string, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((response.body as { message?: unknown }).message, 'Login successful');
  assert.deepEqual(
    (response.body as { user?: unknown }).user,
    { id: user.id, name: user.name, email: user.email } as unknown,
  );
  assert.equal(tokens.verify((response.body as { token: string }).token), user.id);
  assert.equal(compare.mock.callCount(), 1);
  assert.equal(compare.mock.calls[0].arguments[1], passwordHash);
  assert.deepEqual(query.mock.calls[0].arguments[1], [user.email]);
  assert.equal(hash.mock.callCount(), 0);
});
