/**
 * /layouts/* against the real local Postgres+Redis, exercised through the
 * actual Fastify app via app.inject(). Skips gracefully when the local
 * stack isn't up — see app.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultLayoutDefinition } from '@terminal/types';
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
  console.warn('[layoutRoutes.test.ts] local Postgres/Redis not reachable — skipping.');
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, 'expected a Set-Cookie header');
  const value = raw.split(';')[0];
  assert.ok(value);
  return value;
}

async function signUpAndGetCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const email = `layout-test-${randomUUID()}@example.invalid`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'a-reasonably-long-password' },
  });
  assert.equal(signup.statusCode, 201);
  return extractSessionCookie(signup.headers['set-cookie']);
}

test('GET /layouts/default without a session is rejected (GW-2002)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/layouts/default' });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.code, 'GW-2002');
  await app.close();
});

test('GET /layouts/default is null before anything is saved', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);

  const res = await app.inject({ method: 'GET', url: '/layouts/default', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).definition, null);

  await app.close();
});

test('PUT then GET /layouts/default round-trips the saved definition', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);
  const definition = defaultLayoutDefinition();

  const put = await app.inject({
    method: 'PUT',
    url: '/layouts/default',
    headers: { cookie },
    payload: { definition },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(JSON.parse(put.body).ok, true);

  const get = await app.inject({ method: 'GET', url: '/layouts/default', headers: { cookie } });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(JSON.parse(get.body).definition, definition);

  await app.close();
});

test('PUT /layouts/default overwrites the previous definition (single default layout)', {
  skip: !reachable,
}, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);
  const first = defaultLayoutDefinition();
  const second = { version: 1 as const, columns: [{ size: 1, panels: [{ kind: 'news' as const, size: 1 }] }] };

  await app.inject({ method: 'PUT', url: '/layouts/default', headers: { cookie }, payload: { definition: first } });
  await app.inject({ method: 'PUT', url: '/layouts/default', headers: { cookie }, payload: { definition: second } });

  const get = await app.inject({ method: 'GET', url: '/layouts/default', headers: { cookie } });
  assert.deepEqual(JSON.parse(get.body).definition, second);

  await app.close();
});

test('PUT /layouts/default rejects a malformed definition (GW-2010)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);

  const res = await app.inject({
    method: 'PUT',
    url: '/layouts/default',
    headers: { cookie },
    payload: { definition: { version: 1, columns: [] } }, // empty columns — invalid
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'GW-2010');

  await app.close();
});

test('PUT /layouts/default rejects a missing body (GW-2008)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);

  const res = await app.inject({
    method: 'PUT',
    url: '/layouts/default',
    headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'GW-2008');

  await app.close();
});

test('PUT /layouts/default without a session is rejected (GW-2002)', { skip: !reachable }, async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'PUT',
    url: '/layouts/default',
    payload: { definition: defaultLayoutDefinition() },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.code, 'GW-2002');
  await app.close();
});

after(async () => {
  if (reachable) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'layout-test-%@example.invalid'`);
  }
  await pool.end().catch(() => undefined);
  closeSubscriber();
  redis.disconnect();
});
