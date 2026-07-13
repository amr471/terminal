import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapAdjacent } from './tabOrder.js';

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
