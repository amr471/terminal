/**
 * Pure array-reorder helper for the terminal tab strip (P1.3a) — swaps a
 * tab with its immediate left/right neighbor. Kept separate from
 * TerminalTabs.tsx (which owns all the network/state wiring) so the reorder
 * math itself has its own unit test, same split as gatewayUrl.ts.
 */
export function swapAdjacent<T extends { id: string }>(
  items: readonly T[],
  id: string,
  direction: 'left' | 'right',
): T[] {
  const index = items.findIndex((item) => item.id === id);
  const swapWith = direction === 'left' ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= items.length) return [...items];

  const next = [...items];
  const a = next[index];
  const b = next[swapWith];
  if (!a || !b) return [...items];
  next[index] = b;
  next[swapWith] = a;
  return next;
}

/**
 * Pure move-to-arbitrary-position helper for the tab strip's mouse
 * drag-and-drop reorder (P1.3b) — `swapAdjacent` only handles the
 * keyboard's one-step-at-a-time case, a drag can jump straight to any
 * position in one gesture.
 *
 * `targetIndex` is the index the moved item should occupy in the
 * *resulting* array (i.e. as if it had already been removed) — not an
 * index into the original `items`. This sidesteps the usual off-by-one
 * ambiguity of "index in the original array" once the array shrinks by
 * one during the move; callers (see `dropTargetIndex` below) are expected
 * to do that conversion once, here, rather than at every call site.
 */
export function reorderTo<T extends { id: string }>(
  items: readonly T[],
  id: string,
  targetIndex: number,
): T[] {
  const fromIndex = items.findIndex((item) => item.id === id);
  if (fromIndex < 0) return [...items];

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return [...items];

  const clampedTarget = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(clampedTarget, 0, moved);
  return next;
}

/**
 * Converts a drag gesture (dragged tab id, tab id currently under the
 * pointer, and which half of it the pointer is over) into the
 * resulting-array `targetIndex` `reorderTo` expects. Split out from the
 * component so the index math — the fiddly part of any drag-reorder UI —
 * has its own unit tests independent of DOM drag events.
 */
export function dropTargetIndex<T extends { id: string }>(
  items: readonly T[],
  dragId: string,
  hoverId: string,
  insertAfter: boolean,
): number | null {
  const dragIndex = items.findIndex((item) => item.id === dragId);
  const hoverIndex = items.findIndex((item) => item.id === hoverId);
  if (dragIndex < 0 || hoverIndex < 0 || dragIndex === hoverIndex) return null;

  let target = insertAfter ? hoverIndex + 1 : hoverIndex;
  // Removing the dragged item shifts every later index left by one —
  // reorderTo's targetIndex is defined against the array *after* that
  // removal, so account for it here rather than inside reorderTo itself.
  if (dragIndex < target) target -= 1;
  return target;
}
