import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subtractDec,
  bestPriceRowKey,
  isBestPriceServerFrame,
  type BestPriceRow,
} from './bestPrice.js';

function row(p: Partial<BestPriceRow> = {}): BestPriceRow {
  return {
    symbol: 'btcusdt',
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

test('subtractDec is exact beyond float precision and handles signs', () => {
  assert.equal(subtractDec('1', '1.0'), '0');
  assert.equal(subtractDec('67001.25', '67000.50'), '0.75');
  assert.equal(subtractDec('0.1', '0.3'), '-0.2');
  assert.equal(subtractDec('-5', '3'), '-8');
  assert.equal(
    subtractDec('90071992547409910.00000002', '90071992547409910.00000001'),
    '0.00000001',
  );
  assert.equal(subtractDec('100', '100'), '0');
});

test('bestPriceRowKey is the bare symbol (consolidated, not per-venue)', () => {
  assert.equal(bestPriceRowKey(row({ symbol: 'ethusdt' })), 'ethusdt');
});

test('isBestPriceServerFrame accepts valid snapshot/delta/error frames', () => {
  assert.equal(
    isBestPriceServerFrame({
      type: 'bestprice.snapshot',
      subId: 's1',
      rows: [row({ bestBid: '67000.50', bestBidSize: '1.2', bestBidVenue: 'binance' })],
    }),
    true,
  );
  assert.equal(
    isBestPriceServerFrame({
      type: 'bestprice.delta',
      subId: 's1',
      added: [row()],
      updated: [],
      removed: ['ethusdt'],
      order: ['btcusdt'],
    }),
    true,
  );
  assert.equal(
    isBestPriceServerFrame({ type: 'bestprice.unsubscribed', subId: 's1' }),
    true,
  );
  assert.equal(isBestPriceServerFrame({ type: 'error', code: 'GW-2008' }), true);
});

test('isBestPriceServerFrame rejects malformed frames', () => {
  assert.equal(isBestPriceServerFrame(null), false);
  assert.equal(isBestPriceServerFrame({ type: 'bestprice.snapshot', subId: 's1' }), false); // missing rows
  assert.equal(
    isBestPriceServerFrame({
      type: 'bestprice.snapshot',
      subId: 's1',
      rows: [{ symbol: 'btcusdt' }], // missing required fields
    }),
    false,
  );
  assert.equal(
    isBestPriceServerFrame({
      type: 'bestprice.delta',
      subId: 's1',
      added: [],
      updated: [],
      removed: [1], // not a string
      order: [],
    }),
    false,
  );
  assert.equal(isBestPriceServerFrame({ type: 'nonsense' }), false);
});

test('a row with float-leaking numbers is rejected by the frame guard', () => {
  assert.equal(
    isBestPriceServerFrame({
      type: 'bestprice.snapshot',
      subId: 's1',
      rows: [{ ...row(), bestBid: 67000.5 }], // number, not a Dec string
    }),
    false,
  );
});
