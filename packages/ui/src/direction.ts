/**
 * Direction from Dec strings — string inspection only, no float parsing
 * (architecture.md §4.3). Drives the green/red rule: direction colors are
 * reserved for exactly this.
 */
import type { Dec } from '@terminal/types';

export type Direction = 'up' | 'down' | 'flat';

/** '-5.2' → down · '0.00' → flat · '3.1' → up. */
export function decDirection(value: Dec): Direction {
  if (/^-0*(\.0+)?$/.test(value) || /^0*(\.0+)?$/.test(value)) return 'flat';
  return value.startsWith('-') ? 'down' : 'up';
}

/** CSS class for a direction — used by NumCell and anything price-colored. */
export function directionClass(dir: Direction): string {
  return `t-dir-${dir}`;
}
