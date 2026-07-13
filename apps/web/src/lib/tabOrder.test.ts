import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapAdjacent, reorderTo, dropTargetIndex } from './tabOrder.js';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('swapAdjacent: right moves the tab one place later', () => {
  assert.deepEqual(swapAdjacent(items, 'a', 'right'), [{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
});

test('swapAdjacent: left moves the tab one place earlier', () => {
  assert.deepEqual(swapAdjacent(items, 'c', 'left'), [{ id: 'a' }, { id: 'c' }, { id: 'b' }]);
});

test('swapAdjacent: at the start boundary is a no-op (new array, same order)', () => {
  const result = swapAdjacent(items, 'a', 'left');
  assert.deepEqual(result, items);
  assert.notEqual(result, items); // fresh array reference, not the same one
});

test('swapAdjacent: at the end boundary is a no-op', () => {
  assert.deepEqual(swapAdjacent(items, 'c', 'right'), items);
});

test('swapAdjacent: unknown id is a no-op', () => {
  assert.deepEqual(swapAdjacent(items, 'zzz', 'right'), items);
});

const abcd = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

test('reorderTo: moves an item forward to a resulting-array index', () => {
  // 'a' ends up at index 2 of the post-removal array [b,c,d] -> [b,c,a,d]
  assert.deepEqual(reorderTo(abcd, 'a', 2), [{ id: 'b' }, { id: 'c' }, { id: 'a' }, { id: 'd' }]);
});

test('reorderTo: moves an item backward to a resulting-array index', () => {
  // 'd' ends up at index 0 of the post-removal array [a,b,c] -> [d,a,b,c]
  assert.deepEqual(reorderTo(abcd, 'd', 0), [{ id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }]);
});

test('reorderTo: target index equal to the current position is a no-op (still a fresh array)', () => {
  const result = reorderTo(items, 'b', 1);
  assert.deepEqual(result, items);
  assert.notEqual(result, items);
});

test('reorderTo: out-of-range targetIndex clamps rather than throwing', () => {
  assert.deepEqual(reorderTo(items, 'a', 99), [{ id: 'b' }, { id: 'c' }, { id: 'a' }]);
  assert.deepEqual(reorderTo(items, 'c', -5), [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
});

test('reorderTo: unknown id is a no-op (new array, same order)', () => {
  const result = reorderTo(items, 'zzz', 0);
  assert.deepEqual(result, items);
  assert.notEqual(result, items);
});

test('dropTargetIndex: dropping before a later tab', () => {
  assert.equal(dropTargetIndex(abcd, 'a', 'c', false), 1);
});

test('dropTargetIndex: dropping after a later tab', () => {
  assert.equal(dropTargetIndex(abcd, 'a', 'c', true), 2);
});

test('dropTargetIndex: dropping before an earlier tab', () => {
  assert.equal(dropTargetIndex(abcd, 'd', 'b', false), 1);
});

test('dropTargetIndex: dropping after an earlier tab', () => {
  assert.equal(dropTargetIndex(abcd, 'd', 'b', true), 2);
});

test('dropTargetIndex: dropping onto itself is null (no-op)', () => {
  assert.equal(dropTargetIndex(abcd, 'a', 'a', false), null);
});

test('dropTargetIndex: unknown drag or hover id is null', () => {
  assert.equal(dropTargetIndex(abcd, 'zzz', 'a', false), null);
  assert.equal(dropTargetIndex(abcd, 'a', 'zzz', false), null);
});
