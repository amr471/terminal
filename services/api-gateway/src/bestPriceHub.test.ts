/**
 * BestPriceHub snapshot/delta tests (P1.7b). Like screenerHub.test.ts, these
 * exercise the pure diffing/consolidation path only — rows are seeded with
 * setRowsForTest and refreshes driven by hand, so no Postgres/Redis is
 * needed. Unlike ScreenerHub there's no per-subscriber filter, so every
 * subscriber gets the same snapshot/delta stream — these tests assert that
 * sharing, plus the default tightest-spread-first order.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BestPriceHub } from './bestPriceHub.js';
import { redis } from './redis.js';
import type { BestPriceRow } from '@terminal/types';

// Importing bestPriceHub.ts pulls in redis.ts as a module side effect (the
// hub's refresh() reads cache:book:* directly); these tests never call
// refresh()/consolidate() so no live Redis is needed, but the shared client
// still opens a connection and retries indefinitely if unreachable — same
// process-hang footgun pubsub.test.ts documents, same fix.
after(() => {
  redis.disconnect();
});

function row(symbol: string, over: Partial<BestPriceRow> = {}): BestPriceRow {
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
    ...over,
  };
}

interface Frame {
  type: string;
  rows?: BestPriceRow[];
  added?: BestPriceRow[];
  updated?: BestPriceRow[];
  removed?: string[];
  order?: string[];
}

function collector(): { send: (p: Record<string, unknown>) => void; frames: Frame[] } {
  const frames: Frame[] = [];
  return { send: (p) => frames.push(p as unknown as Frame), frames };
}

test('subscribe emits an initial snapshot ordered by tightest spread first', () => {
  const hub = new BestPriceHub();
  hub.setRowsForTest([
    row('btcusdt', { bestBid: '67000', bestAsk: '67010', spread: '10' }),
    row('ethusdt', { bestBid: '3450', bestAsk: '3450.50', spread: '0.50' }),
    row('solusdt'), // no book data yet -> null spread, sorts last
  ]);

  const c = collector();
  hub.subscribe(c.send);

  assert.equal(c.frames.length, 1);
  assert.equal(c.frames[0]?.type, 'bestprice.snapshot');
  assert.deepEqual(
    c.frames[0]?.rows?.map((r) => r.symbol),
    ['ethusdt', 'btcusdt', 'solusdt'],
  );
});

test('a changed value produces an updated delta, broadcast to every subscriber', () => {
  const hub = new BestPriceHub();
  hub.setRowsForTest([row('btcusdt', { bestBid: '67000', bestAsk: '67010', spread: '10' })]);

  const c1 = collector();
  const c2 = collector();
  hub.subscribe(c1.send);
  hub.subscribe(c2.send);
  assert.equal(c1.frames.length, 1);
  assert.equal(c2.frames.length, 1);

  hub.setRowsForTest([
    row('btcusdt', { bestBid: '67005', bestAsk: '67010', spread: '5', bestBidVenue: 'binance' }),
  ]);
  hub.pushDeltaForTest();

  assert.equal(c1.frames.length, 2);
  assert.equal(c2.frames.length, 2);
  const [d1, d2] = [c1.frames[1], c2.frames[1]];
  assert.equal(d1?.type, 'bestprice.delta');
  assert.equal(d1?.updated?.[0]?.bestBid, '67005');
  assert.deepEqual(d1, d2); // identical payload to every subscriber (no per-sub filter)
});

test('refreshes that change nothing screenable stay silent', () => {
  const hub = new BestPriceHub();
  const r = row('btcusdt', { bestBid: '67000', bestAsk: '67010', spread: '10' });
  hub.setRowsForTest([r]);
  const c = collector();
  hub.subscribe(c.send);
  assert.equal(c.frames.length, 1);

  hub.setRowsForTest([r]); // identical row
  hub.pushDeltaForTest();
  assert.equal(c.frames.length, 1, 'no delta when nothing changed');
});

test('symbols entering/leaving the universe are added/removed', () => {
  const hub = new BestPriceHub();
  hub.setRowsForTest([row('btcusdt', { spread: '10', bestBid: '1', bestAsk: '11' })]);
  const c = collector();
  hub.subscribe(c.send);

  hub.setRowsForTest([row('ethusdt', { spread: '1', bestBid: '1', bestAsk: '2' })]);
  hub.pushDeltaForTest();

  const delta = c.frames[1];
  assert.deepEqual(delta?.added?.map((r) => r.symbol), ['ethusdt']);
  assert.deepEqual(delta?.removed, ['btcusdt']);
});

test('unsubscribe stops further deltas for that subscriber only', () => {
  const hub = new BestPriceHub();
  hub.setRowsForTest([row('btcusdt')]);
  const c1 = collector();
  const c2 = collector();
  const unsub1 = hub.subscribe(c1.send);
  hub.subscribe(c2.send);
  unsub1();

  hub.setRowsForTest([row('btcusdt', { bestBid: '1', bestAsk: '2', spread: '1' })]);
  hub.pushDeltaForTest();

  assert.equal(c1.frames.length, 1, 'unsubscribed before the delta');
  assert.equal(c2.frames.length, 2, 'still subscribed');
});

test('a symbol with no live book data anywhere renders as an all-null row, not dropped', () => {
  const hub = new BestPriceHub();
  hub.setRowsForTest([row('newlisting')]);
  const c = collector();
  hub.subscribe(c.send);
  const r = c.frames[0]?.rows?.[0];
  assert.equal(r?.symbol, 'newlisting');
  assert.equal(r?.bestBid, null);
  assert.equal(r?.spread, null);
  assert.equal(r?.venueCount, 0);
});
