/**
 * Integration tests against the real local Redis (P1.0's docker-compose).
 * Skips gracefully — rather than failing the whole suite — when the local
 * stack isn't reachable, e.g. in a sandbox with no Docker (same pattern as
 * session.test.ts).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from './loginThrottle.js';

async function redisReachable(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const reachable = await redisReachable();
if (!reachable) {
  console.warn(
    '[loginThrottle.test.ts] local Redis not reachable — skipping integration tests. ' +
      'Run `pnpm dev:up` to enable them.',
  );
}

function testEmail(): string {
  return `throttle-test-${randomUUID()}@example.invalid`;
}

test('a fresh email is not locked', { skip: !reachable }, async () => {
  const email = testEmail();
  assert.equal(await isLoginLocked(redis, email), false);
});

test('locks out after 10 recorded failures, not before', { skip: !reachable }, async () => {
  const email = testEmail();
  for (let i = 0; i < 9; i++) {
    await recordLoginFailure(redis, email);
    assert.equal(await isLoginLocked(redis, email), false, `should not lock after ${i + 1}`);
  }
  await recordLoginFailure(redis, email);
  assert.equal(await isLoginLocked(redis, email), true);
});

test(
  'clearLoginFailures resets the lock (successful login path)',
  { skip: !reachable },
  async () => {
    const email = testEmail();
    for (let i = 0; i < 10; i++) await recordLoginFailure(redis, email);
    assert.equal(await isLoginLocked(redis, email), true);

    await clearLoginFailures(redis, email);
    assert.equal(await isLoginLocked(redis, email), false);
  },
);

test(
  'lockout tracking is case- and whitespace-insensitive on email',
  { skip: !reachable },
  async () => {
    const email = `Throttle-Case-${randomUUID()}@Example.Invalid`;
    for (let i = 0; i < 10; i++) await recordLoginFailure(redis, `  ${email.toUpperCase()}  `);
    assert.equal(await isLoginLocked(redis, email.toLowerCase().trim()), true);
  },
);

after(async () => {
  redis.disconnect();
});
