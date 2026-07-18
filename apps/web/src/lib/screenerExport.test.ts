import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenerRowsToCsv, screenerExportFilename } from './screenerExport.js';
import type { ScreenerRow } from '@terminal/types';

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

const labels: Record<string, string> = {
  symbol: 'Symbol',
  exchange: 'Exchange',
  price: 'Price',
  volume_24h: 'Volume',
};

test('screenerRowsToCsv: header, raw Dec values (no locale formatting), watermark footer', () => {
  const rows = [row({ symbol: 'btcusdt', price: '64123.5', volume_24h: '1000000000' })];
  const csv = screenerRowsToCsv(
    rows,
    ['symbol', 'exchange', 'price', 'volume_24h'],
    (id) => labels[id]!,
    'Exported from TERMINAL',
  );
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Symbol,Exchange,Price,Volume');
  assert.equal(lines[1], 'btcusdt,binance,64123.5,1000000000'); // exact Dec string, no grouping/comma
  assert.equal(lines[2], ''); // blank separator before the watermark
  assert.equal(lines[3], 'Exported from TERMINAL');
});

test('screenerRowsToCsv: null fields export as empty, not "null"', () => {
  const csv = screenerRowsToCsv(
    [row({ price: null })],
    ['symbol', 'price'],
    (id) => labels[id]!,
    'wm',
  );
  assert.equal(csv.split('\n')[1], 'btcusdt,');
});

test('screenerRowsToCsv: quotes/escapes a value containing a comma', () => {
  const withCommaLabel: Record<string, string> = { ...labels, symbol: 'Symbol, Ticker' };
  const csv = screenerRowsToCsv([row({})], ['symbol'], (id) => withCommaLabel[id]!, 'wm');
  assert.equal(csv.split('\n')[0], '"Symbol, Ticker"');
});

test('screenerExportFilename: zero-padded, sortable date', () => {
  assert.equal(screenerExportFilename(new Date(2026, 0, 5)), 'terminal-screener-2026-01-05.csv');
  assert.equal(screenerExportFilename(new Date(2026, 11, 31)), 'terminal-screener-2026-12-31.csv');
});
