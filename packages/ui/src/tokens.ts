/**
 * Design tokens — Bloomberg-inspired dark terminal (CLAUDE.md §5).
 * Single source of truth: tokens.css is generated FROM this file via
 * `pnpm --filter @terminal/ui gen:css` — never edit tokens.css by hand.
 *
 * Rules the palette encodes:
 * - Black/near-black base; high-contrast data; minimal chrome.
 * - Amber is THE accent (focus, active function, branding).
 * - Green/red are RESERVED for direction (up/down, long/short) — never
 *   decoration. Status uses the health scale instead.
 * - All numbers render in the mono stack so columns align.
 */

export const color = {
  /** Surface scale, darkest → lightest. */
  surface: {
    base: '#000000', // app background
    panel: '#0a0a0a', // panel background
    raised: '#141414', // hover/raised rows, inputs
    overlay: '#1c1c1c', // menus, popovers, command bar dropdown
  },
  border: {
    subtle: '#1f1f1f', // panel separators
    strong: '#333333', // focused panel, dividers under headers
  },
  text: {
    primary: '#e8e6e3', // main data
    secondary: '#9d9a94', // labels, column headers
    muted: '#5c5a55', // disabled, placeholders
    inverse: '#0a0a0a', // text on amber
  },
  /** The Bloomberg amber — accent, focus, active state. */
  accent: {
    amber: '#ffa028',
    amberDim: '#b36f1c', // pressed/secondary accent
    amberGlow: 'rgba(255, 160, 40, 0.15)', // focus rings, selection wash
  },
  /** Direction colors — up/down ONLY. */
  direction: {
    up: '#00d964',
    down: '#ff3b46',
    flat: '#9d9a94', // == text.secondary
  },
  /** Health states (architecture.md §5.5) — deliberately NOT green/red. */
  health: {
    live: '#3fb6ff',
    degraded: '#ffd23f',
    stale: '#ff8a3f',
    down: '#8a8a8a',
  },
  /** Session strip (fixed clock, CLAUDE.md §5). */
  session: {
    active: '#ffa028', // active session == amber
    inactive: '#5c5a55',
    overlap: '#ffd23f',
  },
} as const;

export const font = {
  /** ALL numerals use mono so columns align (CLAUDE.md §5). */
  mono: "'IBM Plex Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  sans: "Inter, 'Helvetica Neue', Arial, sans-serif",
  size: {
    /** Dense data rows — the terminal default. */
    data: '12px',
    label: '11px',
    body: '13px',
    title: '14px',
    /** Status bar clock, command bar input. */
    prominent: '16px',
  },
  weight: { regular: 400, medium: 500, bold: 700 },
} as const;

/** 4px density grid — denser than the usual 8pt; this is a terminal. */
export const space = {
  px: '1px',
  xs: '2px',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '24px',
} as const;

export const layer = {
  base: 0,
  panel: 1,
  statusBar: 100,
  commandBar: 200,
  overlay: 300,
  toast: 400,
} as const;

export const radius = {
  none: '0',
  sm: '2px', // terminals are square; 2px max softening
} as const;

/** Row heights for dense data tables. */
export const density = {
  row: '22px',
  rowRelaxed: '28px',
  statusBar: '28px',
  commandBar: '36px',
} as const;

type TokenLeaf = string | number;
type TokenTree = { [key: string]: TokenLeaf | TokenTree };

export const tokens = {
  color,
  font,
  space,
  layer,
  radius,
  density,
} as const satisfies TokenTree;

/** Flatten the token tree into CSS custom-property pairs (--t-color-surface-base). */
export function toCssVariables(tree: TokenTree = tokens, prefix = '--t'): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(tree)) {
    const name = `${prefix}-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (typeof value === 'object') out.push(...toCssVariables(value, name));
    else out.push([name, String(value)]);
  }
  return out;
}

/** Render the :root block for tokens.css. */
export function renderCss(): string {
  const lines = toCssVariables()
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `/* GENERATED from tokens.ts — do not edit. Run: pnpm --filter @terminal/ui gen:css */\n:root {\n${lines}\n}\n`;
}
