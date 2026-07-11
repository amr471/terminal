import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocale, TRADING_SESSIONS } from './index.js';

test('isLocale accepts only supported locales', () => {
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('ru'), true);
  assert.equal(isLocale('de'), false);
  assert.equal(isLocale(''), false);
});

test('all four trading sessions are defined', () => {
  assert.deepEqual([...TRADING_SESSIONS], ['sydney', 'tokyo', 'london', 'new_york']);
});
