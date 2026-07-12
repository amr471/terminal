import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

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
