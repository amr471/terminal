import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange } from './virtualize.js';

test('visibleRange: at the top, renders the first viewport-full plus overscan below', () => {
  const r = visibleRange(0, 220, 22, 1000, 6);
  assert.equal(r.startIndex, 0); // clamped, no overscan above at the top
  assert.equal(r.endIndex, 16); // ceil(220/22)=10 visible + 6 overscan
  assert.equal(r.offsetY, 0);
  assert.equal(r.totalHeight, 22000);
});

test('visibleRange: scrolled partway down includes overscan on both sides', () => {
  const r = visibleRange(2200, 220, 22, 1000, 6);
  // firstVisible = 2200/22 = 100
  assert.equal(r.startIndex, 94); // 100 - 6
  assert.equal(r.endIndex, 116); // 100 + 10 + 6
  assert.equal(r.offsetY, 94 * 22);
});

test('visibleRange: near the end, endIndex clamps to rowCount', () => {
  const r = visibleRange(21780, 220, 22, 1000, 6); // firstVisible = 989
  assert.equal(r.endIndex, 1000);
  assert.ok(r.startIndex < 1000);
});

test('visibleRange: empty table renders nothing, zero height', () => {
  assert.deepEqual(visibleRange(0, 220, 22, 0), {
    startIndex: 0,
    endIndex: 0,
    offsetY: 0,
    totalHeight: 0,
  });
});

test('visibleRange: degenerate rowHeight is handled without throwing', () => {
  assert.deepEqual(visibleRange(0, 220, 0, 100), {
    startIndex: 0,
    endIndex: 0,
    offsetY: 0,
    totalHeight: 0,
  });
});
