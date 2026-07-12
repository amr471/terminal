import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayUrl } from './gatewayUrl.js';

test('gatewayUrl: defaults to localhost:8080 when GATEWAY_ORIGIN is unset', () => {
  const original = process.env.GATEWAY_ORIGIN;
  delete process.env.GATEWAY_ORIGIN;
  assert.equal(gatewayUrl('/auth/me'), 'http://localhost:8080/auth/me');
  if (original !== undefined) process.env.GATEWAY_ORIGIN = original;
});

test('gatewayUrl: uses GATEWAY_ORIGIN when set', () => {
  const original = process.env.GATEWAY_ORIGIN;
  process.env.GATEWAY_ORIGIN = 'http://gateway.internal:9000';
  assert.equal(gatewayUrl('/layouts/default'), 'http://gateway.internal:9000/layouts/default');
  if (original !== undefined) process.env.GATEWAY_ORIGIN = original;
  else delete process.env.GATEWAY_ORIGIN;
});

test('gatewayUrl: tolerates a path without a leading slash', () => {
  const original = process.env.GATEWAY_ORIGIN;
  process.env.GATEWAY_ORIGIN = 'http://gateway.internal:9000';
  assert.equal(gatewayUrl('auth/me'), 'http://gateway.internal:9000/auth/me');
  if (original !== undefined) process.env.GATEWAY_ORIGIN = original;
  else delete process.env.GATEWAY_ORIGIN;
});
