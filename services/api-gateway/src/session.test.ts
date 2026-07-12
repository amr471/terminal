/**
 * Integration tests against the real local Postgres+Redis (P1.0's
 * docker-compose). Skips gracefully — rather than failing the whole suite —
 * when the local stack isn't reachable, e.g. in a sandbox with no Docker.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { redis } from './redis.js';
import { issueSession, verifySession, revokeSession } from './session.js';
import { createUserWithPassword } from './users.js';
import { hashPassword } from './password.js';

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
  console.warn(
    '[session.test.ts] local Postgres/Redis not reachable — skipping integration tests. ' +
      'Run `pnpm dev:up && pnpm dev:migrate` to enable them.',
  );
}

async function makeTestUser(): Promise<string> {
  const email = `session-test-${randomUUID()}@example.invalid`;
  const passwordHash = await hashPassword('irrelevant-for-this-test');
  return createUserWithPassword(pool, { email, passwordHash, locale: 'en' });
}

test(
  'issueSession + verifySession round-trip resolves the same user',
  { skip: !reachable },
  async () => {
    const userId = await makeTestUser();
    const session = await issueSession(pool, redis, userId);
    const resolved = await verifySession(pool, redis, session.token);
    assert.equal(resolved?.userId, userId);
  },
);

test('verifySession returns null for a garbage token', { skip: !reachable }, async () => {
  const resolved = await verifySession(pool, redis, 'not-a-real-token');
  assert.equal(resolved, null);
});

test('revokeSession invalidates the token', { skip: !reachable }, async () => {
  const userId = await makeTestUser();
  const session = await issueSession(pool, redis, userId);
  await revokeSession(pool, redis, session.token);
  const resolved = await verifySession(pool, redis, session.token);
  assert.equal(resolved, null);
});

test(
  'verifySession still works after a Redis cache miss (falls back to Postgres)',
  { skip: !reachable },
  async () => {
    const userId = await makeTestUser();
    const session = await issueSession(pool, redis, userId);
    await redis.del(`sess:${session.sessionId}`); // simulate a cold/flushed cache
    const resolved = await verifySession(pool, redis, session.token);
    assert.equal(resolved?.userId, userId);
  },
);

after(async () => {
  if (reachable) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'session-test-%@example.invalid'`);
  }
  await pool.end().catch(() => undefined);
  redis.disconnect();
});
