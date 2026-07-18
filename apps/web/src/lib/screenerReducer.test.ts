import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScreenerFrame, screenerStateRows, EMPTY_SCREENER_STATE } from './screenerReducer.js';
import type { ScreenerRow } from '@terminal/types';

function row(symbol: string, p: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    exchange: 'binance',
    symbol,
    asset_class: 'crypto',
    price: null,
    change_1h: null,
    change_24h: null,
    change_7d: null,
    volume_24h: null,
    market_cap: null,
    open_interest: null,
    funding_rate: null,
    volatility_24h: null,
    spread: null,
    ...p,
  };
}

test('applyScreenerFrame: a snapshot replaces state outright, in server order', () => {
  const state = applyScreenerFrame(EMPTY_SCREENER_STATE, {
    type: 'screener.snapshot',
    subId: 's1',
    rows: [row('btcusdt', { volume_24h: '300' }), row('ethusdt', { volume_24h: '100' })],
  });
  assert.deepEqual(
    screenerStateRows(state).map((r) => r.symbol),
    ['btcusdt', 'ethusdt'],
  );
});

test('applyScreenerFrame: a delta merges added/updated and drops removed, adopting the new order', () => {
  const snapshot = applyScreenerFrame(EMPTY_SCREENER_STATE, {
    type: 'screener.snapshot',
    subId: 's1',
    rows: [row('btcusdt', { volume_24h: '300' }), row('ethusdt', { volume_24h: '100' })],
  });
  const next = applyScreenerFrame(snapshot, {
    type: 'screener.delta',
    subId: 's1',
    added: [row('solusdt', { volume_24h: '250' })],
    updated: [row('ethusdt', { volume_24h: '400' })],
    removed: ['binance|btcusdt'],
    order: ['binance|ethusdt', 'binance|solusdt'],
  });
  assert.deepEqual(
    screenerStateRows(next).map((r) => r.symbol),
    ['ethusdt', 'solusdt'],
  );
  assert.equal(screenerStateRows(next)[0]!.volume_24h, '400'); // updated value applied
});

test('screenerStateRows: skips an order key with no matching row (transient race) rather than throwing', () => {
  const state = {
    order: ['binance|ghost', 'binance|btcusdt'],
    byKey: { 'binance|btcusdt': row('btcusdt') },
  };
  assert.deepEqual(
    screenerStateRows(state).map((r) => r.symbol),
    ['btcusdt'],
  );
});

test('applyScreenerFrame: an empty snapshot clears the table', () => {
  const snapshot = applyScreenerFrame(EMPTY_SCREENER_STATE, {
    type: 'screener.snapshot',
    subId: 's1',
    rows: [row('btcusdt')],
  });
  const empty = applyScreenerFrame(snapshot, { type: 'screener.snapshot', subId: 's1', rows: [] });
  assert.deepEqual(screenerStateRows(empty), []);
});
