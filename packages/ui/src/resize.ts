/**
 * Pure track-resize math for the terminal shell's resizable columns/panels
 * (P1.3). Kept free of any DOM/pointer-event code so it's directly
 * node:test-testable (repo convention: no jsdom yet, pure logic only —
 * see docs/landing-page.md's testing-strategy note).
 */
import { MIN_TRACK_SIZE_FR } from '@terminal/types';

/**
 * Converts a pointer-drag distance in pixels to a delta in fr units, given
 * the container's pixel size and the total fr the tracks sum to.
 */
export function pixelDeltaToFr(deltaPx: number, containerSizePx: number, totalFr: number): number {
  if (containerSizePx <= 0 || totalFr <= 0) return 0;
  return (deltaPx / containerSizePx) * totalFr;
}

/**
 * Resizes the boundary between `tracks[index]` and `tracks[index + 1]` by
 * `deltaFr`, taking from one and giving to the other so the total is
 * unchanged. Rejects (returns the input unchanged) rather than partially
 * clamping if either side would drop below MIN_TRACK_SIZE_FR — avoids jitter
 * where a drag "sticks" at the floor while the pointer keeps moving.
 */
export function resizeTracks(
  tracks: readonly number[],
  index: number,
  deltaFr: number,
  minFr: number = MIN_TRACK_SIZE_FR,
): number[] {
  if (index < 0 || index >= tracks.length - 1) return [...tracks];
  const a = tracks[index]! + deltaFr;
  const b = tracks[index + 1]! - deltaFr;
  if (a < minFr || b < minFr) return [...tracks];
  const next = [...tracks];
  next[index] = a;
  next[index + 1] = b;
  return next;
}

/** Renders an fr array as a CSS grid-template track list, e.g. [3, 2] -> "3fr 2fr". */
export function tracksToCssTemplate(tracks: readonly number[]): string {
  return tracks.map((fr) => `${fr}fr`).join(' ');
}
