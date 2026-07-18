/**
 * Pure filter-tree editing ops for the screener's FilterBuilder (P1.7 UI) —
 * the same "pure math, own tests, thin component" split resize.ts/
 * panelOrder.ts already established. FilterBuilder.tsx only turns clicks
 * into calls to these; @terminal/types' `validateFilterNode` (the engine's
 * own budget check, depth <= MAX_FILTER_DEPTH / nodes <= MAX_FILTER_NODES)
 * is the single source of truth for whether an edited tree is still legal —
 * this file doesn't duplicate that check, it just never grows the tree
 * unboundedly on its own (a node is only ever added one at a time, from a
 * user click).
 */
import type {
  CategoricalCondition,
  CategoricalField,
  FilterGroup,
  FilterNode,
  NumericCondition,
  ScreenerField,
} from '@terminal/types';

/** Indices from the root into each nested `children` array. `[]` is the root itself. */
export type NodePath = readonly number[];

function cloneNode(node: FilterNode): FilterNode {
  return node.kind === 'group' ? { ...node, children: node.children.map(cloneNode) } : { ...node };
}

/** A fresh, valid default condition — 'gt 0' reads as a sensible starting
 * point for any numeric field the user hasn't set a value for yet. */
export function defaultNumericCondition(field: ScreenerField): NumericCondition {
  return { kind: 'numeric', field, op: 'gt', value: '0' };
}

export function defaultCategoricalCondition(field: CategoricalField): CategoricalCondition {
  return { kind: 'categorical', field, op: 'in', values: [] };
}

/** A new nested group needs at least one child to stay valid the instant
 * it's created (validateFilterNode rejects empty groups) — seed it with one
 * default condition rather than leaving a transient invalid state. */
export function defaultGroup(logic: FilterGroup['logic'] = 'and'): FilterGroup {
  return { kind: 'group', logic, children: [defaultNumericCondition('volume_24h')] };
}

export function getNodeAtPath(root: FilterGroup, path: NodePath): FilterNode | undefined {
  let node: FilterNode = root;
  for (const index of path) {
    if (node.kind !== 'group') return undefined;
    const group: FilterGroup = node;
    const child: FilterNode | undefined = group.children[index];
    if (!child) return undefined;
    node = child;
  }
  return node;
}

/** Replaces the node at `path` with `next(currentNode)`'s result. Root
 * (`path === []`) is always a group, so `next` is typed for that case via
 * the two overloads callers actually use (updateCondition/updateGroupLogic). */
function replaceAtPath(
  root: FilterGroup,
  path: NodePath,
  next: (node: FilterNode) => FilterNode,
): FilterGroup {
  if (path.length === 0) {
    const replaced = next(root);
    return replaced.kind === 'group' ? replaced : root; // root must stay a group
  }
  const clone = cloneNode(root) as FilterGroup;
  let parent: FilterGroup = clone;
  for (let i = 0; i < path.length - 1; i++) {
    const child = parent.children[path[i]!];
    if (!child || child.kind !== 'group') return root;
    parent = child;
  }
  const targetIndex = path[path.length - 1]!;
  const target = parent.children[targetIndex];
  if (!target) return root;
  parent.children[targetIndex] = next(target);
  return clone;
}

/** Updates a leaf condition in place (field/op/value edits from the builder UI). */
export function updateCondition(
  root: FilterGroup,
  path: NodePath,
  patch: Partial<NumericCondition> | Partial<CategoricalCondition>,
): FilterGroup {
  return replaceAtPath(root, path, (node) => ({ ...node, ...patch }) as FilterNode);
}

/** Flips a group's AND/OR logic (root or nested). */
export function setGroupLogic(
  root: FilterGroup,
  path: NodePath,
  logic: FilterGroup['logic'],
): FilterGroup {
  return replaceAtPath(root, path, (node) => (node.kind === 'group' ? { ...node, logic } : node));
}

/** Appends `child` to the group at `groupPath`'s children array. */
export function addChild(root: FilterGroup, groupPath: NodePath, child: FilterNode): FilterGroup {
  if (groupPath.length === 0)
    return { ...(cloneNode(root) as FilterGroup), children: [...root.children, child] };
  const clone = cloneNode(root) as FilterGroup;
  const group = getNodeAtPath(clone, groupPath);
  if (!group || group.kind !== 'group') return root;
  group.children.push(child);
  return clone;
}

/**
 * Removes the node at `path`. If that empties out its parent group and the
 * parent isn't the root, the now-empty parent group is removed too (walking
 * up as far as needed) — same "don't leave a structurally invalid empty
 * group behind" stance movePanel takes on empty columns. The root group
 * itself is never removed, even if it ends up with zero children (the
 * caller/validateFilterNode is responsible for refusing to run an empty
 * screen; the builder UI should keep at least one row visible instead).
 */
export function removeNode(root: FilterGroup, path: NodePath): FilterGroup {
  if (path.length === 0) return root; // can't remove the root
  const clone = cloneNode(root) as FilterGroup;

  // Walk to the parent group, collecting ancestors so we can collapse
  // upward if removal empties a non-root group out.
  const ancestors: FilterGroup[] = [clone];
  for (let i = 0; i < path.length - 1; i++) {
    const parent = ancestors[ancestors.length - 1]!;
    const next = parent.children[path[i]!];
    if (!next || next.kind !== 'group') return root;
    ancestors.push(next);
  }

  let removeIndex = path[path.length - 1]!;
  for (let depth = ancestors.length - 1; depth >= 0; depth--) {
    const group = ancestors[depth]!;
    if (removeIndex < 0 || removeIndex >= group.children.length) return root;
    group.children.splice(removeIndex, 1);
    if (group.children.length > 0 || depth === 0) break; // root always stays
    // This group is now empty and isn't the root — remove it from *its*
    // parent instead, one level up.
    removeIndex = path[depth - 1]!;
  }
  return clone;
}
