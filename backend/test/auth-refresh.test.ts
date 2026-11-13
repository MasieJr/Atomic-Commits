import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import bcrypt from 'bcrypt';
import { Pool } from 'pg';

import { createApp } from '../src/app';
import { createRefreshTokenService } from '../src/services/refresh-tokens';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the database tests';
const jwtSecret = 'auth-refresh-test-secret-at-least-32-characters';

async function createUser(pool: Pool): Promise<{ id: number; email: string }> {
  const email = `refresh-test-${randomBytes(4).toString('hex')}@example.test`;
  const passwordHash = await bcrypt.hash('test-password', 12);
  const { rows } = await pool.query(
    `INSERT INTO app_private.users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    ['Refresh Test', email, passwordHash],
  );
  return { id: rows[0].id as number, email };
}

test('refresh tokens rotate, and reusing a rotated token revokes the family', { skip }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const refreshTokens = createRefreshTokenService(pool);
  const user = await createUser(pool);
  t.after(async () => {
    await pool.query(`DELETE FROM app_private.users WHERE id = $1`, [user.id]);
    await pool.end();
  });

  const first = await refreshTokens.issue(user.id);
  const rotated = await refreshTokens.rotate(first);
  assert.ok(rotated);
  assert.notEqual(rotated.token, first);
  assert.equal(rotated.userId, user.id);

  /* presenting the spent token again is treated as theft: the whole
     family dies, including the token rotation just handed out */
  assert.equal(await refreshTokens.rotate(first), undefined);
  assert.equal(await refreshTokens.rotate(rotated.token), undefined);

  /* a fresh sign-in still works afterwards */
  const fresh = await refreshTokens.issue(user.id);
  const again = await refreshTokens.rotate(fresh);
  assert.ok(again);
  assert.equal(again.userId, user.id);

  await refreshTokens.revoke(again.token);
  assert.equal(await refreshTokens.rotate(again.token), undefined);
});

test('login issues a refresh token that exchanges for a new pair until it is reused', { skip }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const { app, close } = createApp({
    databaseUrl,
    jwtSecret,
    emailVerification: { sendCode: async () => {}, verifyCode: async () => {} },
  });
  const server = app.listen(0, '127.0.0.1');
  const email = `refresh-http-${randomBytes(4).toString('hex')}@example.test`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await close();
    await pool.query(`DELETE FROM app_private.users WHERE email = $1`, [email]);
    await pool.end();
  });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function post(path: string, body: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const registered = await post('/api/auth/register', {
    name: 'Refresh Test', email, password: 'test-password', emailCode: '123456',
  });
  assert.equal(registered.status, 201);
  const firstRefresh = registered.body.refreshToken;
  assert.equal(typeof firstRefresh, 'string');

  const renewed = await post('/api/auth/refresh', { refreshToken: firstRefresh });
  assert.equal(renewed.status, 200);
  const secondRefresh = renewed.body.refreshToken;
  assert.equal(typeof secondRefresh, 'string');
  assert.notEqual(secondRefresh, firstRefresh);
  assert.equal(typeof renewed.body.token, 'string');

  /* the spent token is rejected and revokes its replacement too */
  const reused = await post('/api/auth/refresh', { refreshToken: firstRefresh });
  assert.equal(reused.status, 401);
  const orphaned = await post('/api/auth/refresh', { refreshToken: secondRefresh });
  assert.equal(orphaned.status, 401);
});
