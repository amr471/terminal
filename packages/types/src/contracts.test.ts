import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDec,
  isEnvelope,
  mdChannel,
  parseMdChannel,
  validateFilterNode,
  isValidScreenDefinition,
  isAlertNode,
  worstState,
  isErrorCode,
  MAX_FILTER_NODES,
  validateLayoutDefinition,
  isValidLayoutDefinition,
  defaultLayoutDefinition,
  MAX_LAYOUT_COLUMNS,
  isValidTabTitle,
  MAX_TAB_TITLE_LENGTH,
  type FilterGroup,
  type Envelope,
  type TradePayload,
} from './index.js';

test('isDec accepts string decimals only', () => {
  assert.equal(isDec('64123.50'), true);
  assert.equal(isDec('-0.052'), true);
  assert.equal(isDec('12'), true);
  assert.equal(isDec('1e5'), false); // no scientific notation on the wire
  assert.equal(isDec('12.'), false);
  assert.equal(isDec(64123.5), false); // numbers are not Dec — strings only
  assert.equal(isDec('NaN'), false);
});

test('envelope guard validates the §4.2 shape', () => {
  const msg: Envelope<TradePayload> = {
    v: 1,
    type: 'trade',
    src: 'binance',
    sym: 'btcusdt',
    ts: 1783793088123,
    rts: 1783793088140,
    seq: 42,
    data: { price: '64123.50', qty: '0.5', side: 'buy' },
  };
  assert.equal(isEnvelope(msg), true);
  assert.equal(isEnvelope({ ...msg, v: 2 }), false);
  assert.equal(isEnvelope({ ...msg, type: 'unknown' }), false);
  assert.equal(isEnvelope(null), false);
});

test('md channel builder and parser round-trip', () => {
  assert.equal(
    mdChannel({ exchange: 'binance', symbol: 'btcusdt', kind: 'trades' }),
    'md.binance.btcusdt.trades',
  );
  assert.equal(
    mdChannel({ exchange: 'okx', symbol: 'ethusdt', kind: 'candles', tf: '5m' }),
    'md.okx.ethusdt.candles.5m',
  );
  assert.deepEqual(parseMdChannel('md.bybit.solusdt.book'), {
    exchange: 'bybit',
    symbol: 'solusdt',
    kind: 'book',
  });
  assert.deepEqual(parseMdChannel('md.binance.btcusdt.candles.1h'), {
    exchange: 'binance',
    symbol: 'btcusdt',
    kind: 'candles',
    tf: '1h',
  });
  assert.equal(parseMdChannel('md.binance.btcusdt.candles.7m'), null);
  assert.equal(parseMdChannel('evt.alert_fired'), null);
  assert.equal(parseMdChannel('md.binance.btcusdt.nonsense'), null);
});

test('screener filter validation: the canonical example passes', () => {
  // volume > 100M AND funding < 0 AND change_24h < -5% (CLAUDE.md §6.1)
  const def = {
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
    sort: { field: 'volume_24h', dir: 'desc' },
  };
  assert.equal(isValidScreenDefinition(def), true);
});

test('screener filter validation rejects malformed trees', () => {
  assert.ok(
    validateFilterNode({ kind: 'numeric', field: 'nope', op: 'gt', value: '1' }).length > 0,
  );
  assert.ok(validateFilterNode({ kind: 'group', logic: 'xor', children: [] }).length > 0);
  assert.ok(
    validateFilterNode({
      kind: 'numeric',
      field: 'price',
      op: 'between',
      value: '5',
    }).length > 0,
  );
  // float leak: numbers are not Dec strings
  assert.ok(
    validateFilterNode({ kind: 'numeric', field: 'price', op: 'gt', value: 100 }).length > 0,
  );
});

test('screener filter validation enforces node budget (hostile input)', () => {
  const wide: FilterGroup = {
    kind: 'group',
    logic: 'or',
    children: Array.from({ length: MAX_FILTER_NODES + 1 }, () => ({
      kind: 'numeric' as const,
      field: 'price' as const,
      op: 'gt' as const,
      value: '1',
    })),
  };
  assert.ok(validateFilterNode(wide).length > 0);
});

test('alert node guard accepts valid trees and rejects junk', () => {
  assert.equal(
    isAlertNode({
      kind: 'group',
      logic: 'and',
      children: [
        {
          kind: 'price',
          exchange: 'binance',
          symbol: 'btcusdt',
          op: 'crosses_above',
          level: '70000',
        },
        { kind: 'news', assets: ['btc'], sentiment: 'bearish' },
      ],
    }),
    true,
  );
  assert.equal(isAlertNode({ kind: 'group', logic: 'and', children: [] }), false);
  assert.equal(isAlertNode({ kind: 'telepathy' }), false);
});

test('worstState aggregates in severity order', () => {
  assert.equal(worstState(['LIVE', 'LIVE']), 'LIVE');
  assert.equal(worstState(['LIVE', 'DEGRADED', 'STALE']), 'STALE');
  assert.equal(worstState(['DOWN', 'LIVE']), 'DOWN');
  assert.equal(worstState([]), 'LIVE');
});

test('error codes are stable and guarded', () => {
  assert.equal(isErrorCode('MD-1001'), true);
  assert.equal(isErrorCode('XX-9999'), false);
});

test('the default layout (screener + chart + news) is itself valid', () => {
  assert.equal(isValidLayoutDefinition(defaultLayoutDefinition()), true);
});

test('layout definition validation rejects malformed shapes', () => {
  assert.ok(validateLayoutDefinition(null).length > 0);
  assert.ok(validateLayoutDefinition({ version: 2, columns: [] }).length > 0);
  assert.ok(validateLayoutDefinition({ version: 1, columns: [] }).length > 0); // empty
  assert.ok(
    validateLayoutDefinition({
      version: 1,
      columns: [{ size: 1, panels: [{ kind: 'nope', size: 1 }] }],
    }).length > 0,
  );
  assert.ok(
    validateLayoutDefinition({
      version: 1,
      columns: [{ size: 0, panels: [{ kind: 'screener', size: 1 }] }],
    }).length > 0,
  ); // size below MIN_TRACK_SIZE_FR
  assert.ok(
    validateLayoutDefinition({ version: 1, columns: [{ size: 1, panels: [] }] }).length > 0,
  ); // empty panels
});

test('layout definition validation enforces the column budget (hostile input)', () => {
  const tooWide = {
    version: 1,
    columns: Array.from({ length: MAX_LAYOUT_COLUMNS + 1 }, () => ({
      size: 1,
      panels: [{ kind: 'screener', size: 1 }],
    })),
  };
  assert.ok(validateLayoutDefinition(tooWide).length > 0);
});

test('isValidTabTitle accepts a normal title, rejects blank/oversized/wrong-type', () => {
  assert.equal(isValidTabTitle('Scalping'), true);
  assert.equal(isValidTabTitle('a'.repeat(MAX_TAB_TITLE_LENGTH)), true);
  assert.equal(isValidTabTitle('a'.repeat(MAX_TAB_TITLE_LENGTH + 1)), false);
  assert.equal(isValidTabTitle(''), false);
  assert.equal(isValidTabTitle('   '), false);
  assert.equal(isValidTabTitle(42), false);
  assert.equal(isValidTabTitle(null), false);
});
