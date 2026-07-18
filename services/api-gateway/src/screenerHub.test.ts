/**
 * ScreenerHub snapshot/delta tests (P1.6). These exercise the pure diffing path
 * only — the working set is seeded with setWorkingSetForTest and refreshes are
 * driven by hand, so no Postgres/Redis is needed (unlike ws.test.ts). We assert
 * the wire contract the browser depends on: an initial `screener.snapshot`, then
 * `screener.delta` frames carrying only added/updated/removed rows + the new
 * order, and silence when nothing screenable changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenerHub } from './screenerHub.js';
import type { ScreenerRow, ScreenDefinition } from '@terminal/types';

function row(exchange: string, symbol: string, over: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    exchange,
    symbol,
    asset_class: 'crypto',
    price: '100',
    change_1h: '0',
    change_24h: '0',
    change_7d: '0',
    volume_24h: '1000000',
    market_cap: null,
    open_interest: null,
    funding_rate: '0',
    volatility_24h: null,
    spread: null,
    ...over,
  };
}

// Everything with volume_24h > 0, sorted by volume desc (default).
const allByVolume: ScreenDefinition = {
  version: 1,
  root: {
    kind: 'group',
    logic: 'and',
    children: [{ kind: 'numeric', field: 'volume_24h', op: 'gt', value: '0' }],
  },
};

interface Frame {
  type: string;
  rows?: ScreenerRow[];
  added?: ScreenerRow[];
  updated?: ScreenerRow[];
  removed?: string[];
  order?: string[];
}

function collector(): { send: (p: Record<string, unknown>) => void; frames: Frame[] } {
  const frames: Frame[] = [];
  return { send: (p) => frames.push(p as unknown as Frame), frames };
}

test('subscribe emits an initial snapshot in sort order', () => {
  const hub = new ScreenerHub();
  hub.setWorkingSetForTest([
    row('binance', 'BTCUSDT', { volume_24h: '500' }),
    row('binance', 'ETHUSDT', { volume_24h: '900' }),
    row('binance', 'XRPUSDT', { volume_24h: '100' }),
  ]);

  const c = collector();
  hub.subscribe(allByVolume, c.send);

  assert.equal(c.frames.length, 1);
  const snap = c.frames[0];
  assert.equal(snap?.type, 'screener.snapshot');
  assert.deepEqual(
    snap?.rows?.map((r) => r.symbol),
    ['ETHUSDT', 'BTCUSDT', 'XRPUSDT'],
  );
});

test('a changed value produces an updated delta; unrelated refreshes are silent', async () => {
  const hub = new ScreenerHub();
  hub.setWorkingSetForTest([row('binance', 'BTCUSDT', { volume_24h: '500' })]);

  const c = collector();
  hub.subscribe(allByVolume, c.send);
  assert.equal(c.frames.length, 1); // snapshot

  // Reseed with the same screenable values -> no delta.
  hub.setWorkingSetForTest([row('binance', 'BTCUSDT', { volume_24h: '500' })]);
  await hub.refreshForTest();
  assert.equal(c.frames.length, 1, 'no delta when nothing screenable changed');

  // Now change the price (a screenable numeric) -> one updated row.
  hub.setWorkingSetForTest([row('binance', 'BTCUSDT', { volume_24h: '500', price: '123' })]);
  await hub.refreshForTest();
  assert.equal(c.frames.length, 2);
  const delta = c.frames[1];
  assert.equal(delta?.type, 'screener.delta');
  assert.equal(delta?.added?.length, 0);
  assert.equal(delta?.updated?.length, 1);
  assert.equal(delta?.updated?.[0]?.price, '123');
  assert.equal(delta?.removed?.length, 0);
});

test('rows entering and leaving the result set are added/removed', async () => {
  const hub = new ScreenerHub();
  // Only match volume > 1000.
  const def: ScreenDefinition = {
    version: 1,
    root: {
      kind: 'group',
      logic: 'and',
      children: [{ kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1000' }],
    },
  };
  hub.setWorkingSetForTest([row('binance', 'BTCUSDT', { volume_24h: '5000' })]);

  const c = collector();
  hub.subscribe(def, c.send);
  assert.equal(c.frames[0]?.rows?.length, 1);

  // ETH crosses the threshold in; BTC drops out.
  hub.setWorkingSetForTest([
    row('binance', 'BTCUSDT', { volume_24h: '10' }),
    row('binance', 'ETHUSDT', { volume_24h: '9000' }),
  ]);
  await hub.refreshForTest();

  const delta = c.frames[1];
  assert.equal(delta?.type, 'screener.delta');
  assert.deepEqual(
    delta?.added?.map((r) => r.symbol),
    ['ETHUSDT'],
  );
  assert.deepEqual(delta?.removed, ['binance|BTCUSDT']);
});

test('unsubscribe stops further deltas', async () => {
  const hub = new ScreenerHub();
  hub.setWorkingSetForTest([row('binance', 'BTCUSDT')]);
  const c = collector();
  const unsub = hub.subscribe(allByVolume, c.send);
  unsub();

  hub.setWorkingSetForTest([row('binance', 'BTCUSDT', { price: '999' })]);
  await hub.refreshForTest();
  assert.equal(c.frames.length, 1, 'only the initial snapshot, no post-unsub delta');
});
