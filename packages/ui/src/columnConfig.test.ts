import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleColumn,
  reorderColumn,
  DEFAULT_VISIBLE_COLUMNS,
  ALL_SCREENER_COLUMNS,
} from './columnConfig.js';

test('DEFAULT_VISIBLE_COLUMNS is a subset of ALL_SCREENER_COLUMNS', () => {
  for (const c of DEFAULT_VISIBLE_COLUMNS) assert.ok(ALL_SCREENER_COLUMNS.includes(c));
});

test('toggleColumn: hides a visible column', () => {
  const next = toggleColumn(['symbol', 'price', 'volume_24h'], 'price');
  assert.deepEqual(next, ['symbol', 'volume_24h']);
});

test('toggleColumn: shows a hidden column by appending it', () => {
  const next = toggleColumn(['symbol', 'price'], 'volume_24h');
  assert.deepEqual(next, ['symbol', 'price', 'volume_24h']);
});

test('toggleColumn: refuses to hide the last remaining column', () => {
  const next = toggleColumn(['symbol'], 'symbol');
  assert.deepEqual(next, ['symbol']);
});

test('reorderColumn: moves a column to an earlier index', () => {
  const next = reorderColumn(['symbol', 'price', 'volume_24h'], 'volume_24h', 0);
  assert.deepEqual(next, ['volume_24h', 'symbol', 'price']);
});

test('reorderColumn: moves a column to a later index', () => {
  const next = reorderColumn(['symbol', 'price', 'volume_24h'], 'symbol', 2);
  assert.deepEqual(next, ['price', 'volume_24h', 'symbol']);
});

test('reorderColumn: unknown column is a no-op (fresh array, same order)', () => {
  const visible = ['symbol', 'price'] as const;
  const next = reorderColumn(visible, 'volume_24h', 0);
  assert.deepEqual(next, visible);
  assert.notEqual(next, visible);
});

test('reorderColumn: out-of-range targetIndex clamps rather than throwing', () => {
  const next = reorderColumn(['symbol', 'price', 'volume_24h'], 'symbol', 99);
  assert.deepEqual(next, ['price', 'volume_24h', 'symbol']);
});
