import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBestPriceFrame,
  bestPriceStateRows,
  EMPTY_BEST_PRICE_STATE,
} from './bestPriceReducer.js';
import type { BestPriceRow } from '@terminal/types';

function row(symbol: string, p: Partial<BestPriceRow> = {}): BestPriceRow {
  return {
    symbol,
    assetClass: 'crypto',
    bestBid: null,
    bestBidSize: null,
    bestBidVenue: null,
    bestAsk: null,
    bestAskSize: null,
    bestAskVenue: null,
    spread: null,
    venueCount: 0,
    ...p,
  };
}

test('applyBestPriceFrame: a snapshot replaces state outright, in server order', () => {
  const state = applyBestPriceFrame(EMPTY_BEST_PRICE_STATE, {
    type: 'bestprice.snapshot',
    subId: 's1',
    rows: [row('ethusdt', { spread: '0.5' }), row('btcusdt', { spread: '10' })],
  });
  assert.deepEqual(
    bestPriceStateRows(state).map((r) => r.symbol),
    ['ethusdt', 'btcusdt'],
  );
});

test('applyBestPriceFrame: a delta merges added/updated and drops removed, adopting the new order', () => {
  const snapshot = applyBestPriceFrame(EMPTY_BEST_PRICE_STATE, {
    type: 'bestprice.snapshot',
    subId: 's1',
    rows: [row('btcusdt', { bestBid: '67000' }), row('ethusdt', { bestBid: '3450' })],
  });
  const next = applyBestPriceFrame(snapshot, {
    type: 'bestprice.delta',
    subId: 's1',
    added: [row('solusdt', { bestBid: '170' })],
    updated: [row('ethusdt', { bestBid: '3455' })],
    removed: ['btcusdt'],
    order: ['ethusdt', 'solusdt'],
  });
  assert.deepEqual(
    bestPriceStateRows(next).map((r) => r.symbol),
    ['ethusdt', 'solusdt'],
  );
  assert.equal(bestPriceStateRows(next)[0]!.bestBid, '3455'); // updated value applied
});

test('bestPriceStateRows: skips an order key with no matching row (transient race) rather than throwing', () => {
  const state = {
    order: ['ghostusdt', 'btcusdt'],
    byKey: { btcusdt: row('btcusdt') },
  };
  assert.deepEqual(
    bestPriceStateRows(state).map((r) => r.symbol),
    ['btcusdt'],
  );
});

test('applyBestPriceFrame: an empty snapshot clears the table', () => {
  const snapshot = applyBestPriceFrame(EMPTY_BEST_PRICE_STATE, {
    type: 'bestprice.snapshot',
    subId: 's1',
    rows: [row('btcusdt')],
  });
  const empty = applyBestPriceFrame(snapshot, {
    type: 'bestprice.snapshot',
    subId: 's1',
    rows: [],
  });
  assert.deepEqual(bestPriceStateRows(empty), []);
});
