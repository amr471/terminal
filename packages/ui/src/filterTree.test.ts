import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FilterGroup } from '@terminal/types';
import {
  getNodeAtPath,
  updateCondition,
  setGroupLogic,
  addChild,
  removeNode,
  defaultNumericCondition,
  defaultCategoricalCondition,
  defaultGroup,
} from './filterTree.js';

function sampleTree(): FilterGroup {
  return {
    kind: 'group',
    logic: 'and',
    children: [
      { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '100000000' },
      {
        kind: 'group',
        logic: 'or',
        children: [
          { kind: 'numeric', field: 'funding_rate', op: 'lt', value: '0' },
          { kind: 'numeric', field: 'change_24h', op: 'lt', value: '-0.05' },
        ],
      },
    ],
  };
}

test('getNodeAtPath: root, top-level, and nested lookups', () => {
  const root = sampleTree();
  assert.equal(getNodeAtPath(root, []), root);
  assert.deepEqual(getNodeAtPath(root, [0]), {
    kind: 'numeric',
    field: 'volume_24h',
    op: 'gt',
    value: '100000000',
  });
  assert.deepEqual(getNodeAtPath(root, [1, 1]), {
    kind: 'numeric',
    field: 'change_24h',
    op: 'lt',
    value: '-0.05',
  });
});

test('getNodeAtPath: out-of-range or malformed paths return undefined', () => {
  const root = sampleTree();
  assert.equal(getNodeAtPath(root, [5]), undefined);
  assert.equal(getNodeAtPath(root, [0, 0]), undefined); // [0] is a leaf, not a group
});

test('updateCondition: edits a leaf without mutating the input tree', () => {
  const root = sampleTree();
  const next = updateCondition(root, [0], { value: '200000000' });
  assert.equal((next.children[0] as { value: string }).value, '200000000');
  assert.equal((root.children[0] as { value: string }).value, '100000000'); // original untouched
});

test('updateCondition: edits a nested leaf', () => {
  const root = sampleTree();
  const next = updateCondition(root, [1, 0], { op: 'gte' });
  const group = next.children[1] as FilterGroup;
  assert.equal((group.children[0] as { op: string }).op, 'gte');
});

test('setGroupLogic: flips root and nested group logic independently', () => {
  const root = sampleTree();
  const nextRoot = setGroupLogic(root, [], 'or');
  assert.equal(nextRoot.logic, 'or');
  assert.equal(root.logic, 'and');

  const nextNested = setGroupLogic(root, [1], 'and');
  assert.equal((nextNested.children[1] as FilterGroup).logic, 'and');
});

test('addChild: appends to root and to a nested group', () => {
  const root = sampleTree();
  const cond = defaultNumericCondition('price');

  const withRootChild = addChild(root, [], cond);
  assert.equal(withRootChild.children.length, 3);
  assert.deepEqual(withRootChild.children[2], cond);

  const withNestedChild = addChild(root, [1], cond);
  const group = withNestedChild.children[1] as FilterGroup;
  assert.equal(group.children.length, 3);
});

test('removeNode: removes a leaf that is not the last child of its group', () => {
  const root = sampleTree();
  const next = removeNode(root, [1, 1]);
  const group = next.children[1] as FilterGroup;
  assert.equal(group.children.length, 1);
  assert.equal((group.children[0] as { field: string }).field, 'funding_rate');
});

test('removeNode: emptying a non-root group collapses that group out of its parent', () => {
  const root: FilterGroup = {
    kind: 'group',
    logic: 'and',
    children: [
      { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1' },
      {
        kind: 'group',
        logic: 'or',
        children: [{ kind: 'numeric', field: 'price', op: 'gt', value: '0' }],
      },
    ],
  };
  const next = removeNode(root, [1, 0]);
  assert.equal(next.children.length, 1); // the now-empty nested group is gone entirely
  assert.equal((next.children[0] as { field: string }).field, 'volume_24h');
});

test('removeNode: the root is never removed, even down to zero children', () => {
  const root: FilterGroup = {
    kind: 'group',
    logic: 'and',
    children: [{ kind: 'numeric', field: 'price', op: 'gt', value: '0' }],
  };
  const next = removeNode(root, [0]);
  assert.equal(next.kind, 'group');
  assert.equal(next.children.length, 0);
});

test('removeNode: path === [] (root itself) is a no-op', () => {
  const root = sampleTree();
  assert.deepEqual(removeNode(root, []), root);
});

test('default factories produce valid, sensible starting nodes', () => {
  assert.deepEqual(defaultNumericCondition('price'), {
    kind: 'numeric',
    field: 'price',
    op: 'gt',
    value: '0',
  });
  assert.deepEqual(defaultCategoricalCondition('exchange'), {
    kind: 'categorical',
    field: 'exchange',
    op: 'in',
    values: [],
  });
  const group = defaultGroup();
  assert.equal(group.kind, 'group');
  assert.equal(group.logic, 'and');
  assert.equal(group.children.length, 1); // never starts empty (validateFilterNode would reject that)
});
