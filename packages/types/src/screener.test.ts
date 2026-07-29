import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDec,
  consolidateByVenuePreference,
  filterInputToDec,
  decToFilterInput,
  SCREENER_FIELD_UNITS,
  SCREENER_FIELDS,
  evaluateFilter,
  isStockToken,
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

test('runScreen: alphabetical sort by symbol (2026-07-19)', () => {
  const rows = [
    row({ symbol: 'ethusdt', price: '1' }),
    row({ symbol: 'btcusdt', price: '2' }),
    row({ symbol: 'solusdt', price: '3' }),
  ];
  const def: ScreenDefinition = {
    version: 1,
    root: {
      kind: 'group',
      logic: 'or',
      children: [{ kind: 'numeric', field: 'price', op: 'gt', value: '0' }],
    },
    sort: { field: 'symbol', dir: 'asc' },
  };
  assert.deepEqual(
    runScreen(def, rows).map((r) => r.symbol),
    ['btcusdt', 'ethusdt', 'solusdt'],
  );
  assert.deepEqual(
    runScreen({ ...def, sort: { field: 'symbol', dir: 'desc' } }, rows).map((r) => r.symbol),
    ['solusdt', 'ethusdt', 'btcusdt'],
  );
});

test('filterInputToDec: percent fields are typed as percent, stored as a fraction', () => {
  // The footgun this exists to remove: "10" in a 24h % filter means 10%, and
  // the kernel compares against fractions, so it must become 0.1 — not 10.
  assert.equal(filterInputToDec('10', 'percent'), '0.1');
  assert.equal(filterInputToDec('-5.2', 'percent'), '-0.052');
  assert.equal(filterInputToDec('0.1', 'percent'), '0.001');
  assert.equal(filterInputToDec('10%', 'percent'), '0.1'); // trailing % tolerated
  assert.equal(filterInputToDec('100', 'percent'), '1');
  assert.equal(filterInputToDec('0', 'percent'), '0'); // never "-0"
});

test('filterInputToDec: money fields accept K/M/B shorthand', () => {
  assert.equal(filterInputToDec('100M', 'money'), '100000000');
  assert.equal(filterInputToDec('1.5b', 'money'), '1500000000');
  assert.equal(filterInputToDec('250k', 'money'), '250000');
  assert.equal(filterInputToDec('1,000,000', 'money'), '1000000'); // separators stripped
  assert.equal(filterInputToDec('4200', 'money'), '4200');
});

test('filterInputToDec: plain fields pass through, junk returns null', () => {
  assert.equal(filterInputToDec('63500.25', 'plain'), '63500.25');
  for (const junk of ['', '  ', '-', 'abc', '1.2.3', '10M', '--5']) {
    assert.equal(filterInputToDec(junk, 'plain'), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('filterInputToDec: exactness is preserved (no float round-trip)', () => {
  // 0.1 + 0.2 style drift would show up here immediately.
  assert.equal(filterInputToDec('0.07', 'percent'), '0.0007');
  assert.equal(filterInputToDec('123.456', 'percent'), '1.23456');
  // A magnitude no float64 can hold exactly.
  assert.equal(filterInputToDec('12345678901234567890', 'plain'), '12345678901234567890');
});

test('decToFilterInput round-trips with filterInputToDec', () => {
  for (const [typed, unit] of [
    ['10', 'percent'],
    ['-5.2', 'percent'],
    ['0.07', 'percent'],
    ['63500.25', 'plain'],
  ] as const) {
    const stored = filterInputToDec(typed, unit);
    assert.ok(stored !== null);
    assert.equal(decToFilterInput(stored, unit), typed.replace(/^\+/, ''));
  }
});

test('SCREENER_FIELD_UNITS covers every numeric field', () => {
  for (const f of SCREENER_FIELDS) {
    assert.ok(SCREENER_FIELD_UNITS[f], `missing unit for ${f}`);
  }
  // The fields stored as fractions must all be 'percent' — this is the
  // mapping that prevents the 10-means-1000% bug.
  for (const f of ['change_1h', 'change_24h', 'change_7d', 'funding_rate', 'spread'] as const) {
    assert.equal(SCREENER_FIELD_UNITS[f], 'percent');
  }
});

test('consolidateByVenuePreference: prefers binance when it lists the symbol', () => {
  const rows = [
    row({ exchange: 'kucoin', symbol: 'btcusdt', volume_24h: '10' }),
    row({ exchange: 'binance', symbol: 'btcusdt', volume_24h: '20' }),
    row({ exchange: 'bybit', symbol: 'btcusdt', volume_24h: '30' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.exchange, 'binance');
});

test('consolidateByVenuePreference: falls back to another venue when binance is absent', () => {
  const rows = [
    row({ exchange: 'kucoin', symbol: 'dymusdt' }),
    row({ exchange: 'bybit', symbol: 'dymusdt' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.equal(result.length, 1);
  // bybit ranks above kucoin in EXCHANGES' default priority order.
  assert.equal(result[0]?.exchange, 'bybit');
});

test('consolidateByVenuePreference: one row per symbol, other symbols untouched', () => {
  const rows = [
    row({ exchange: 'binance', symbol: 'btcusdt' }),
    row({ exchange: 'kucoin', symbol: 'btcusdt' }),
    row({ exchange: 'kucoin', symbol: 'dymusdt' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.deepEqual(
    result.map((r) => `${r.exchange}:${r.symbol}`).sort(),
    ['binance:btcusdt', 'kucoin:dymusdt'],
  );
});

test('consolidateByVenuePreference: preserves the input array\'s relative order', () => {
  const rows = [
    row({ exchange: 'binance', symbol: 'ethusdt', volume_24h: '5' }),
    row({ exchange: 'kucoin', symbol: 'btcusdt', volume_24h: '3' }),
    row({ exchange: 'binance', symbol: 'btcusdt', volume_24h: '3' }),
  ];
  // Already sorted desc by volume as runScreen would produce; consolidating
  // must not re-sort — only drop the losing kucoin btcusdt duplicate.
  assert.deepEqual(
    consolidateByVenuePreference(rows).map((r) => r.symbol),
    ['ethusdt', 'btcusdt'],
  );
});

test('consolidateByVenuePreference: strict priority order beats volume (2026-07-26)', () => {
  const rows = [
    // kucoin has far more volume, but bybit ranks higher in EXCHANGES, and
    // priority is now strict — bybit wins. (This reverses the 2026-07-19
    // volume-based fallback; see the function's doc comment for why.)
    row({ exchange: 'bybit', symbol: 'dymusdt', volume_24h: '100' }),
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '9000' }),
    row({ exchange: 'okx', symbol: 'dymusdt', volume_24h: '500' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.exchange, 'bybit');
});

test('consolidateByVenuePreference: a user-supplied order is honored end to end', () => {
  const rows = [
    row({ exchange: 'binance', symbol: 'dymusdt', volume_24h: '9999' }),
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '1' }),
    row({ exchange: 'mexc', symbol: 'dymusdt', volume_24h: '5' }),
  ];
  // "if mexc, then everything is on mexc" — mexc first, despite lowest volume
  // and despite binance being present.
  const mexcFirst = ['mexc', 'kucoin', 'binance'];
  assert.equal(consolidateByVenuePreference(rows, mexcFirst)[0]?.exchange, 'mexc');

  // Drop mexc from the data: falls through to the next listed venue, kucoin.
  const noMexc = rows.filter((r) => r.exchange !== 'mexc');
  assert.equal(consolidateByVenuePreference(noMexc, mexcFirst)[0]?.exchange, 'kucoin');
});

test('consolidateByVenuePreference: venues absent from the priority list rank last, by volume', () => {
  const rows = [
    row({ exchange: 'newvenue-a', symbol: 'dymusdt', volume_24h: '10' }),
    row({ exchange: 'newvenue-b', symbol: 'dymusdt', volume_24h: '900' }),
  ];
  // Neither is in EXCHANGES, so volume decides between them (never excluded).
  assert.equal(consolidateByVenuePreference(rows)[0]?.exchange, 'newvenue-b');

  // ...but any ranked venue still beats both.
  const withRanked = [...rows, row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '1' })];
  assert.equal(consolidateByVenuePreference(withRanked)[0]?.exchange, 'kucoin');
});

test('consolidateByVenuePreference: binance still wins outright even when another venue has more volume', () => {
  const rows = [
    row({ exchange: 'binance', symbol: 'dymusdt', volume_24h: '10' }),
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '9000' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.equal(result[0]?.exchange, 'binance');
});

test('consolidateByVenuePreference: a known volume beats an unknown one among EQUALLY-ranked venues', () => {
  // Both unranked, so volume is the only discriminator.
  const rows = [
    row({ exchange: 'unranked-a', symbol: 'dymusdt', volume_24h: null }),
    row({ exchange: 'unranked-b', symbol: 'dymusdt', volume_24h: '42' }),
  ];
  assert.equal(consolidateByVenuePreference(rows)[0]?.exchange, 'unranked-b');

  // But rank still dominates volume: bybit outranks kucoin even with no volume.
  const ranked = [
    row({ exchange: 'bybit', symbol: 'dymusdt', volume_24h: null }),
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '42' }),
  ];
  assert.equal(consolidateByVenuePreference(ranked)[0]?.exchange, 'bybit');
});

test('consolidateByVenuePreference: an unlisted venue ranks last, not excluded', () => {
  const rows = [
    row({ exchange: 'some-new-venue', symbol: 'btcusdt' }),
    row({ exchange: 'kucoin', symbol: 'btcusdt' }),
  ];
  assert.equal(consolidateByVenuePreference(rows)[0]?.exchange, 'kucoin');

  const onlyUnlisted = [row({ exchange: 'some-new-venue', symbol: 'btcusdt' })];
  assert.equal(consolidateByVenuePreference(onlyUnlisted).length, 1);
});

// Removed the cross-venue fill 2026-07-26: a row must never show another
// venue's number. Borrowing contradicted the priority picker AND made the table
// self-inconsistent — OI visible under "All exchanges" disappeared when the
// user picked that same exchange, because the quick-pick filters server-side
// and removed the donor rows.
test('consolidateByVenuePreference: never borrows OI/funding from another venue', () => {
  const rows = [
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '9000', open_interest: null, funding_rate: null }),
    row({ exchange: 'bybit', symbol: 'dymusdt', volume_24h: '100', open_interest: '5000', funding_rate: '-0.0001' }),
  ];
  const result = consolidateByVenuePreference(rows, ['kucoin', 'bybit']);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.exchange, 'kucoin');
  assert.equal(result[0]?.volume_24h, '9000');
  assert.equal(result[0]?.open_interest, null, "must stay blank — bybit's OI is not kucoin's");
  assert.equal(result[0]?.funding_rate, null);
});

// The consistency guarantee the removal buys: filtering to one exchange must
// not change any value, only which rows survive.
test('consolidateByVenuePreference: single-exchange view matches the all-exchange row', () => {
  const all = [
    row({ exchange: 'binance', symbol: 'btcusdc', volume_24h: '900', open_interest: null }),
    row({ exchange: 'bybit', symbol: 'btcusdc', volume_24h: '100', open_interest: '777' }),
  ];
  const allView = consolidateByVenuePreference(all);
  // Same data as the server would send once filtered to binance.
  const binanceOnly = consolidateByVenuePreference(all.filter((r) => r.exchange === 'binance'));

  assert.equal(allView[0]?.exchange, 'binance');
  assert.equal(allView[0]?.open_interest, binanceOnly[0]?.open_interest);
  assert.equal(allView[0]?.open_interest, null);
});

test('consolidateByVenuePreference: keeps the winner\'s own OI/funding', () => {
  const rows = [
    row({ exchange: 'binance', symbol: 'btcusdt', volume_24h: '10', open_interest: '111', funding_rate: '0.0002' }),
    row({ exchange: 'okx', symbol: 'btcusdt', volume_24h: '9000', open_interest: '222', funding_rate: '0.0009' }),
  ];
  const result = consolidateByVenuePreference(rows);
  assert.equal(result[0]?.exchange, 'binance');
  assert.equal(result[0]?.open_interest, '111'); // not overwritten by okx
  assert.equal(result[0]?.funding_rate, '0.0002');
});

test('consolidateByVenuePreference: OI stays null when the winning venue has none', () => {
  const rows = [
    row({ exchange: 'kucoin', symbol: 'dymusdt', volume_24h: '9000', open_interest: null }),
    row({ exchange: 'mexc', symbol: 'dymusdt', volume_24h: '100', open_interest: null }),
  ];
  assert.equal(consolidateByVenuePreference(rows)[0]?.open_interest, null);
});

test('isStockToken: matches Bybit\'s TradFi stock-perp naming convention', () => {
  assert.equal(isStockToken('amdstockusdt'), true);
  assert.equal(isStockToken('AAPLSTOCKUSDT'), true);
  assert.equal(isStockToken('btcusdt'), false);
  assert.equal(isStockToken('dymusdt'), false);
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
