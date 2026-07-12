import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  verifyTelegramLogin,
  isTelegramLoginPayload,
  type TelegramLoginPayload,
} from './telegramAuth.js';

const BOT_TOKEN = 'test-bot-token-123';

function sign(fields: Omit<TelegramLoginPayload, 'hash'>): TelegramLoginPayload {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${String(fields[key as keyof typeof fields])}`)
    .join('\n');
  const secretKey = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

test('verifyTelegramLogin accepts a correctly signed, fresh payload', () => {
  const payload = sign({
    id: 12345,
    first_name: 'Ada',
    auth_date: Math.floor(Date.now() / 1000),
  });
  assert.equal(verifyTelegramLogin(payload, BOT_TOKEN), true);
});

test('verifyTelegramLogin rejects a tampered field', () => {
  const payload = sign({
    id: 12345,
    first_name: 'Ada',
    auth_date: Math.floor(Date.now() / 1000),
  });
  payload.first_name = 'Eve'; // hash no longer matches
  assert.equal(verifyTelegramLogin(payload, BOT_TOKEN), false);
});

test('verifyTelegramLogin rejects the wrong bot token', () => {
  const payload = sign({
    id: 12345,
    first_name: 'Ada',
    auth_date: Math.floor(Date.now() / 1000),
  });
  assert.equal(verifyTelegramLogin(payload, 'a-different-bot-token'), false);
});

test('verifyTelegramLogin rejects a stale payload (>24h old)', () => {
  const payload = sign({
    id: 12345,
    first_name: 'Ada',
    auth_date: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
  });
  assert.equal(verifyTelegramLogin(payload, BOT_TOKEN), false);
});

test('isTelegramLoginPayload validates the minimal required shape', () => {
  assert.equal(isTelegramLoginPayload({ id: 1, first_name: 'A', auth_date: 1, hash: 'x' }), true);
  assert.equal(isTelegramLoginPayload({ id: 1 }), false);
  assert.equal(isTelegramLoginPayload(null), false);
});
