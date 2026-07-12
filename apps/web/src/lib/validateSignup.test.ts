import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignupInput, PASSWORD_MIN_LENGTH } from './validateSignup.js';

test('accepts a well-formed email and long-enough password', () => {
  const errors = validateSignupInput('trader@example.com', 'a-reasonably-long-password');
  assert.deepEqual(errors, {});
});

test('flags a malformed email', () => {
  const errors = validateSignupInput('not-an-email', 'a-reasonably-long-password');
  assert.equal(errors.email, 'invalid_email');
  assert.equal(errors.password, undefined);
});

test('flags a too-short password', () => {
  const errors = validateSignupInput('trader@example.com', 'short');
  assert.equal(errors.password, 'password_too_short');
});

test('PASSWORD_MIN_LENGTH mirrors the server schema (authSchemas.ts min(10))', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 10);
});

test('trims surrounding whitespace before validating the email', () => {
  const errors = validateSignupInput('  trader@example.com  ', 'a-reasonably-long-password');
  assert.deepEqual(errors, {});
});

test('flags both fields independently when both are invalid', () => {
  const errors = validateSignupInput('nope', 'short');
  assert.equal(errors.email, 'invalid_email');
  assert.equal(errors.password, 'password_too_short');
});
