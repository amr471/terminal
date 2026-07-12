/**
 * End-to-end auth flow against the real local Postgres+Redis, exercised
 * through the actual Fastify app via `app.inject()` (no real port needed).
 * Skips gracefully when the local stack isn't up — see session.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { closeSubscriber } from './pubsub.js';

async function servicesReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const reachable = await servicesReachable();
if (!reachable) {
  console.warn('[app.test.ts] local Postgres/Redis not reachable — skipping.');
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, 'expected a Set-Cookie header');
  const value = raw.split(';')[0];
  assert.ok(value);
  return value;
}

test('signup -> me -> logout -> me (rejected)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const email = `app-test-${randomUUID()}@example.invalid`;

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'a-reasonably-long-password' },
  });
  assert.equal(signup.statusCode, 201);
  const cookie = extractSessionCookie(signup.headers['set-cookie']);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(JSON.parse(me.body).email, email);

  const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 204);

  const meAfterLogout = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  assert.equal(meAfterLogout.statusCode, 401);
  assert.equal(JSON.parse(meAfterLogout.body).error.code, 'GW-2002');

  await app.close();
});

test('signup twice with the same email is rejected (GW-2006)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const email = `app-test-${randomUUID()}@example.invalid`;
  const payload = { email, password: 'a-reasonably-long-password' };

  const first = await app.inject({ method: 'POST', url: '/auth/signup', payload });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({ method: 'POST', url: '/auth/signup', payload });
  assert.equal(second.statusCode, 409);
  assert.equal(JSON.parse(second.body).error.code, 'GW-2006');

  await app.close();
});

test(
  'login with wrong password is rejected without revealing which field was wrong',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const email = `app-test-${randomUUID()}@example.invalid`;
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'a-reasonably-long-password' },
    });

    const badLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'totally-wrong' },
    });
    assert.equal(badLogin.statusCode, 401);
    assert.equal(JSON.parse(badLogin.body).error.code, 'GW-2001');

    const unknownEmailLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: `nobody-${randomUUID()}@example.invalid`, password: 'whatever12345' },
    });
    assert.equal(unknownEmailLogin.statusCode, 401);
    assert.equal(JSON.parse(unknownEmailLogin.body).error.code, 'GW-2001');

    await app.close();
  },
);

test('login with correct credentials issues a working session', { skip: !reachable }, async () => {
  const app = await buildApp();
  const email = `app-test-${randomUUID()}@example.invalid`;
  const password = 'a-reasonably-long-password';
  await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200);
  const cookie = extractSessionCookie(login.headers['set-cookie']);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);

  await app.close();
});

test('/auth/me without a session cookie is rejected (GW-2002)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/auth/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.code, 'GW-2002');
  await app.close();
});

test(
  '/auth/google redirects when configured, else reports GW-2007',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/google' });
    // Test env has no Google credentials by default — assert the graceful-degradation path.
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2007');
    await app.close();
  },
);

after(async () => {
  if (reachable) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'app-test-%@example.invalid'`);
  }
  await pool.end().catch(() => undefined);
  // buildApp() pulls in ws.ts -> pubsub.ts, which opens its own dedicated Redis
  // subscriber connection at module load time (independent of the shared `redis`
  // client below) — must be closed explicitly or the test process hangs on a
  // connection that keeps retrying forever when Postgres/Redis aren't reachable.
  closeSubscriber();
  redis.disconnect();
});
