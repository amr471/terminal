import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authErrorMessageKey } from './authErrorMessage.js';

test('maps known GW codes to their catalog keys', () => {
  assert.equal(authErrorMessageKey('GW-2001'), 'error.GW-2001');
  assert.equal(authErrorMessageKey('GW-2004'), 'error.GW-2004');
  assert.equal(authErrorMessageKey('GW-2006'), 'error.GW-2006');
});

test('falls back to the generic error for codes with no dedicated copy', () => {
  assert.equal(authErrorMessageKey('GW-2008'), 'error.generic');
  assert.equal(authErrorMessageKey('GW-2009'), 'error.generic');
});

test('falls back to the generic error for unknown or missing codes', () => {
  assert.equal(authErrorMessageKey('GW-9999'), 'error.generic');
  assert.equal(authErrorMessageKey(undefined), 'error.generic');
});
