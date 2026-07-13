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
