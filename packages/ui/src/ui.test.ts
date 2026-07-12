import { test } from 'node:test';
import assert from 'node:assert/strict';
import { color, toCssVariables, renderCss } from './tokens.js';
import { decDirection } from './direction.js';
import { parseCommand } from './command.js';
import { pixelDeltaToFr, resizeTracks, tracksToCssTemplate } from './resize.js';

// ── WCAG contrast verification (design-token contract) ───────────────────────

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('primary text on all surfaces meets WCAG AA (4.5:1) — data must be readable', () => {
  for (const surface of Object.values(color.surface)) {
    assert.ok(
      contrast(color.text.primary, surface) >= 4.5,
      `text.primary on ${surface}: ${contrast(color.text.primary, surface).toFixed(2)}`,
    );
  }
});

test('direction colors are readable on panel background (dense table case)', () => {
  assert.ok(contrast(color.direction.up, color.surface.panel) >= 4.5);
  assert.ok(contrast(color.direction.down, color.surface.panel) >= 4.5);
});

test('amber accent is readable on base and panel', () => {
  assert.ok(contrast(color.accent.amber, color.surface.base) >= 4.5);
  assert.ok(contrast(color.accent.amber, color.surface.panel) >= 4.5);
});

test('inverse text on amber (buttons/chips) meets AA', () => {
  assert.ok(contrast(color.text.inverse, color.accent.amber) >= 4.5);
});

// ── token → CSS generation ───────────────────────────────────────────────────

test('toCssVariables flattens with kebab-case names', () => {
  const vars = new Map(toCssVariables());
  assert.equal(vars.get('--t-color-surface-base'), '#000000');
  assert.equal(vars.get('--t-color-accent-amber'), '#ffa028');
  assert.equal(vars.get('--t-density-status-bar'), '28px');
  assert.equal(vars.get('--t-layer-command-bar'), '200');
});

test('renderCss produces a :root block with every variable', () => {
  const css = renderCss();
  assert.ok(css.startsWith('/* GENERATED'));
  assert.ok(css.includes(':root {'));
  assert.equal((css.match(/--t-/g) ?? []).length, toCssVariables().length);
});

// ── direction from Dec strings ───────────────────────────────────────────────

test('decDirection: sign inspection only, zero-aware', () => {
  assert.equal(decDirection('5.2'), 'up');
  assert.equal(decDirection('-5.2'), 'down');
  assert.equal(decDirection('0'), 'flat');
  assert.equal(decDirection('0.00'), 'flat');
  assert.equal(decDirection('-0.00'), 'flat');
  assert.equal(decDirection('0.001'), 'up');
});

// ── command grammar ──────────────────────────────────────────────────────────

test('parseCommand: SYMBOL FUNCTION grammar from CLAUDE.md §5', () => {
  assert.deepEqual(parseCommand('BTC HEAT'), { symbol: 'BTC', fn: 'HEAT' });
  assert.deepEqual(parseCommand('aapl chart'), { symbol: 'AAPL', fn: 'CHART' });
  assert.deepEqual(parseCommand('ETH NEWS'), { symbol: 'ETH', fn: 'NEWS' });
});

test('parseCommand: single-token forms', () => {
  assert.deepEqual(parseCommand('NEWS'), { fn: 'NEWS' }); // bare function
  assert.deepEqual(parseCommand('SOL'), { symbol: 'SOL', fn: 'CHART' }); // bare symbol → chart
});

test('parseCommand: rejects garbage', () => {
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('   '), null);
  assert.equal(parseCommand('BTC HEAT NOW'), null);
  assert.equal(parseCommand('BTC NOPE'), null);
  assert.equal(parseCommand('!!! HEAT'), null);
});

// ── resizable terminal shell (P1.3) ──────────────────────────────────────────

test('pixelDeltaToFr: converts a pixel drag to a proportional fr delta', () => {
  // 100px of a 1000px container, 2 total fr -> 0.2fr
  assert.equal(pixelDeltaToFr(100, 1000, 2), 0.2);
  assert.equal(pixelDeltaToFr(-100, 1000, 2), -0.2);
  assert.equal(pixelDeltaToFr(100, 0, 2), 0); // guards zero-size container
});

test('resizeTracks: takes from one neighbor and gives to the other, total unchanged', () => {
  const next = resizeTracks([1, 1], 0, 0.3);
  assert.deepEqual(next, [1.3, 0.7]);
  assert.equal(next[0]! + next[1]!, 2);
});

test('resizeTracks: rejects (no partial clamp) once either side would cross the floor', () => {
  // Track 1 starts at 0.2 (the floor); shrinking it further should be a no-op,
  // not a clamp that sticks at the floor while the pointer keeps moving.
  const tracks = [1.8, 0.2];
  const next = resizeTracks(tracks, 0, 0.05, 0.2);
  assert.deepEqual(next, tracks);
});

test('resizeTracks: out-of-range boundary index is a no-op', () => {
  assert.deepEqual(resizeTracks([1, 1, 1], -1, 0.1), [1, 1, 1]);
  assert.deepEqual(resizeTracks([1, 1, 1], 2, 0.1), [1, 1, 1]);
});

test('tracksToCssTemplate: renders fr arrays as CSS grid track lists', () => {
  assert.equal(tracksToCssTemplate([1, 1]), '1fr 1fr');
  assert.equal(tracksToCssTemplate([3, 1, 1]), '3fr 1fr 1fr');
});
