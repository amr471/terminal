import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramLoginUrl } from './telegramLoginUrl.js';

test('buildTelegramLoginUrl: builds the oauth.telegram.org redirect with all required params', () => {
  const url = buildTelegramLoginUrl({
    botId: '123456789',
    origin: 'https://localhost:3000',
    returnTo: 'https://localhost:3000/api/auth/telegram/callback',
  });
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, 'https://oauth.telegram.org/auth');
  assert.equal(parsed.searchParams.get('bot_id'), '123456789');
  assert.equal(parsed.searchParams.get('origin'), 'https://localhost:3000');
  assert.equal(parsed.searchParams.get('embed'), '0');
  assert.equal(parsed.searchParams.get('request_access'), 'write');
  assert.equal(
    parsed.searchParams.get('return_to'),
    'https://localhost:3000/api/auth/telegram/callback',
  );
});

test('buildTelegramLoginUrl: different bot ids produce different links', () => {
  const a = buildTelegramLoginUrl({ botId: '1', origin: 'https://x', returnTo: 'https://x/cb' });
  const b = buildTelegramLoginUrl({ botId: '2', origin: 'https://x', returnTo: 'https://x/cb' });
  assert.notEqual(a, b);
});
