import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, gatewayWsUrl } from './gatewaySocket.js';

test('backoffDelayMs: doubles each attempt, capped at maxMs', () => {
  assert.equal(backoffDelayMs(0), 1000);
  assert.equal(backoffDelayMs(1), 2000);
  assert.equal(backoffDelayMs(2), 4000);
  assert.equal(backoffDelayMs(3), 8000);
  assert.equal(backoffDelayMs(5), 30000); // 1000*2^5=32000, capped
  assert.equal(backoffDelayMs(20), 30000); // stays capped, never overflows
});

test('backoffDelayMs: negative attempt is treated as attempt 0', () => {
  assert.equal(backoffDelayMs(-1), 1000);
});

test('gatewayWsUrl: wss over https, matching the same-origin /api/ws rewrite', () => {
  assert.equal(
    gatewayWsUrl({ protocol: 'https:', host: 'localhost:3000' }),
    'wss://localhost:3000/api/ws',
  );
});

test('gatewayWsUrl: ws over plain http (local dev before HTTPS is configured)', () => {
  assert.equal(
    gatewayWsUrl({ protocol: 'http:', host: 'localhost:3000' }),
    'ws://localhost:3000/api/ws',
  );
});
