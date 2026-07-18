import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDec,
  evaluateFilter,
  runScreen,
  validateFilterNode,
  isScreenerServerFrame,
  screenerRowKey,
  type ScreenerRow,
  type ScreenDefinition,
  type FilterNode,
} from './screener.js';

function row(p: Partial<ScreenerRow>): ScreenerRow {
  return {
    exchange: 'binance',
    symbol: 'btcusdt',
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

test('compareDec is exact beyond float precision', () => {
  // These two differ only in the last digit, past float64's ~15–16 sig figs.
  assert.equal(compareDec('90071992547409910.00000001', '90071992547409910.00000002'), -1);
  assert.equal(compareDec('1', '1.0'), 0);
  assert.equal(compareDec('-0.05', '-0.04'), -1); // more negative is smaller
  assert.equal(compareDec('-0.05', '-0.06'), 1);
  assert.equal(compareDec('100000000', '99999999.99'), 1);
  assert.equal(compareDec('0', '-0'), 0);
});

test('numeric ops', () => {
  const r = row({ price: '64000.5' });
  const cond = (op: string, value: string): FilterNode =>
    ({ kind: 'numeric', field: 'price', op: op as never, value }) as FilterNode;
  assert.equal(evaluateFilter(cond('gt', '64000'), r), true);
  assert.equal(evaluateFilter(cond('gt', '64000.5'), r), false);
  assert.equal(evaluateFilter(cond('gte', '64000.5'), r), true);
  assert.equal(evaluateFilter(cond('lt', '64001'), r), true);
  assert.equal(evaluateFilter(cond('eq', '64000.50'), r), true); // trailing zero irrelevant
  assert.equal(evaluateFilter(cond('neq', '64000.50'), r), false);
});

test('between op is inclusive', () => {
  const cond: FilterNode = {
    kind: 'numeric',
    field: 'price',
    op: 'between',
    value: ['100', '200'],
  };
  assert.equal(evaluateFilter(cond, row({ price: '100' })), true);
  assert.equal(evaluateFilter(cond, row({ price: '200' })), true);
  assert.equal(evaluateFilter(cond, row({ price: '99.999' })), false);
  assert.equal(evaluateFilter(cond, row({ price: '200.001' })), false);
});

test('a null field never satisfies a numeric condition', () => {
  const cond: FilterNode = { kind: 'numeric', field: 'change_24h', op: 'lt', value: '0' };
  assert.equal(evaluateFilter(cond, row({ change_24h: null })), false);
  assert.equal(evaluateFilter(cond, row({ change_24h: '-0.01' })), true);
});

test('categorical in / not_in', () => {
  const inCond: FilterNode = {
    kind: 'categorical',
    field: 'exchange',
    op: 'in',
    values: ['binance', 'okx'],
  };
  assert.equal(evaluateFilter(inCond, row({ exchange: 'binance' })), true);
  assert.equal(evaluateFilter(inCond, row({ exchange: 'bybit' })), false);
  const notIn: FilterNode = {
    kind: 'categorical',
    field: 'asset_class',
    op: 'not_in',
    values: ['stock'],
  };
  assert.equal(evaluateFilter(notIn, row({ asset_class: 'crypto' })), true);
  assert.equal(evaluateFilter(notIn, row({ asset_class: 'stock' })), false);
});

test('and / or group logic', () => {
  const and: FilterNode = {
    kind: 'group',
    logic: 'and',
    children: [
      { kind: 'numeric', field: 'price', op: 'gt', value: '10' },
      { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '100' },
    ],
  };
  assert.equal(evaluateFilter(and, row({ price: '20', volume_24h: '200' })), true);
  assert.equal(evaluateFilter(and, row({ price: '20', volume_24h: '50' })), false);
  const or: FilterNode = { ...and, logic: 'or' };
  assert.equal(evaluateFilter(or, row({ price: '20', volume_24h: '50' })), true);
  assert.equal(evaluateFilter(or, row({ price: '5', volume_24h: '50' })), false);
});

test('canonical example: volume>100M AND funding<0 AND change_24h<-5%', () => {
  const def: ScreenDefinition = {
    version: 1,
    root: {
      kind: 'group',
      logic: 'and',
      children: [
        { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '100000000' },
        { kind: 'numeric', field: 'funding_rate', op: 'lt', value: '0' },
        { kind: 'numeric', field: 'change_24h', op: 'lt', value: '-0.05' },
      ],
    },
  };
  assert.equal(validateFilterNode(def.root).length, 0); // sanity: valid def
  const hit = row({ volume_24h: '250000000', funding_rate: '-0.0001', change_24h: '-0.08' });
  const missVol = row({ volume_24h: '50000000', funding_rate: '-0.0001', change_24h: '-0.08' });
  const missChange = row({ volume_24h: '250000000', funding_rate: '-0.0001', change_24h: '-0.04' });
  assert.equal(evaluateFilter(def.root, hit), true);
  assert.equal(evaluateFilter(def.root, missVol), false);
  assert.equal(evaluateFilter(def.root, missChange), false);
});

test('runScreen: filters, sorts by volume desc, nulls last, applies limit', () => {
  const rows = [
    row({ symbol: 'a', price: '1', volume_24h: '100' }),
    row({ symbol: 'b', price: '1', volume_24h: '300' }),
    row({ symbol: 'c', price: '1', volume_24h: null }), // matches filter but null volume
    row({ symbol: 'd', price: '1', volume_24h: '200' }),
    row({ symbol: 'e', price: '0', volume_24h: '999' }), // filtered out (price not > 0)
  ];
  const def: ScreenDefinition = {
    version: 1,
    root: {
      kind: 'group',
      logic: 'and',
      children: [{ kind: 'numeric', field: 'price', op: 'gt', value: '0' }],
    },
    limit: 3,
  };
  const out = runScreen(def, rows).map((r) => r.symbol);
  // e filtered; sorted b(300),d(200),a(100),c(null last); limit 3 -> b,d,a
  assert.deepEqual(out, ['b', 'd', 'a']);
});

test('runScreen: explicit ascending sort on a chosen field', () => {
  const rows = [
    row({ symbol: 'a', price: '3' }),
    row({ symbol: 'b', price: '1' }),
    row({ symbol: 'c', price: '2' }),
  ];
  const def: ScreenDefinition = {
    version: 1,
    root: {
      kind: 'group',
      logic: 'or',
      children: [{ kind: 'numeric', field: 'price', op: 'gt', value: '0' }],
    },
    sort: { field: 'price', dir: 'asc' },
  };
  assert.deepEqual(
    runScreen(def, rows).map((r) => r.symbol),
    ['b', 'c', 'a'],
  );
});

// ── WS wire frame guard (P1.7 UI) ────────────────────────────────────────────

test('screenerRowKey matches the gateway ScreenerHub key shape', () => {
  assert.equal(screenerRowKey({ exchange: 'binance', symbol: 'btcusdt' }), 'binance|btcusdt');
});

test('isScreenerServerFrame accepts a real snapshot/delta and rejects junk', () => {
  const snapshot = { type: 'screener.snapshot', subId: 's1', rows: [row({ symbol: 'a' })] };
  assert.equal(isScreenerServerFrame(snapshot), true);

  const delta = {
    type: 'screener.delta',
    subId: 's1',
    added: [row({ symbol: 'b' })],
    updated: [],
    removed: ['binance|old'],
    order: ['binance|btcusdt'],
  };
  assert.equal(isScreenerServerFrame(delta), true);

  assert.equal(isScreenerServerFrame({ type: 'screener.unsubscribed', subId: 's1' }), true);
  assert.equal(isScreenerServerFrame({ type: 'error', code: 'GW-2008' }), true);

  assert.equal(isScreenerServerFrame(null), false);
  assert.equal(isScreenerServerFrame({ type: 'md', channel: 'md.binance.btcusdt.trades' }), false);
  assert.equal(
    isScreenerServerFrame({ type: 'screener.snapshot', subId: 's1', rows: [{ bad: true }] }),
    false,
  );
  assert.equal(isScreenerServerFrame({ type: 'screener.delta', subId: 's1' }), false); // missing arrays
});
