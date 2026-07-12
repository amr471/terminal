import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyPasswordTimingSafe } from './password.js';

test('hashPassword produces an argon2id hash, never the plaintext', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(hash.includes('correct horse battery staple'), false);
});

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
});

test('verifyPassword rejects the wrong password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword(hash, 'wrong password'), false);
});

test('verifyPassword returns false (not throw) on a malformed hash', async () => {
  assert.equal(await verifyPassword('not-a-real-hash', 'anything'), false);
});

test('verifyPasswordTimingSafe rejects when hash is null/undefined (no user)', async () => {
  assert.equal(await verifyPasswordTimingSafe(null, 'anything'), false);
  assert.equal(await verifyPasswordTimingSafe(undefined, 'anything'), false);
});

test('verifyPasswordTimingSafe still verifies correctly when a hash is present', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPasswordTimingSafe(hash, 'correct horse battery staple'), true);
  assert.equal(await verifyPasswordTimingSafe(hash, 'wrong password'), false);
});

test('verifyPasswordTimingSafe takes comparable time for missing vs. wrong password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  // Warm up (argon2 first-call overhead, dummy-hash memoization) before timing.
  await verifyPasswordTimingSafe(hash, 'warmup');
  await verifyPasswordTimingSafe(null, 'warmup');

  const t0 = performance.now();
  await verifyPasswordTimingSafe(hash, 'wrong password');
  const wrongPasswordMs = performance.now() - t0;

  const t1 = performance.now();
  await verifyPasswordTimingSafe(null, 'wrong password');
  const noUserMs = performance.now() - t1;

  // Generous tolerance (CI machines are noisy) — this is a smoke test that the
  // no-user path isn't trivially fast (i.e. skipping argon2 entirely), not a
  // precise timing-attack proof.
  const ratio = Math.max(wrongPasswordMs, noUserMs) / Math.min(wrongPasswordMs, noUserMs);
  assert.ok(ratio < 3, `expected comparable timing, got ${wrongPasswordMs}ms vs ${noUserMs}ms`);
});
