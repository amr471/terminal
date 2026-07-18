/**
 * Command bar model (CLAUDE.md §5): `SYMBOL FUNCTION` jumps anywhere —
 * `BTC HEAT`, `AAPL CHART`, `ETH NEWS`. This is the deterministic parse
 * skeleton; fuzzy search over symbols+functions lands at P1.5.
 */

export const COMMAND_FUNCTIONS = {
  CHART: 'nav.charts',
  HEAT: 'nav.liq_map',
  NEWS: 'nav.news',
  SCREEN: 'nav.screener',
  CAL: 'nav.calendar',
  JRNL: 'nav.journal',
  AL: 'nav.alerts',
  BEST: 'nav.best_price',
} as const;

export type CommandFunction = keyof typeof COMMAND_FUNCTIONS;

export interface ParsedCommand {
  /** Uppercased symbol, if present ('BTC'). */
  symbol?: string;
  fn: CommandFunction;
}

export function isCommandFunction(token: string): token is CommandFunction {
  return token in COMMAND_FUNCTIONS;
}

/**
 * Parse a command-bar input. Grammar (case-insensitive):
 *   `<symbol> <fn>`  → jump to fn for symbol   (BTC HEAT)
 *   `<fn>`           → jump to fn, keep symbol context (NEWS)
 *   `<symbol>`       → default function = CHART (AAPL)
 * Returns null for empty/garbage input (>2 tokens, empty string).
 */
export function parseCommand(input: string): ParsedCommand | null {
  const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined || tokens.length > 2) return null;
  if (tokens.length === 1) {
    if (isCommandFunction(first)) return { fn: first };
    if (/^[A-Z0-9]{1,12}$/.test(first)) return { symbol: first, fn: 'CHART' };
    return null;
  }
  const second = tokens[1];
  if (second !== undefined && isCommandFunction(second) && /^[A-Z0-9]{1,12}$/.test(first)) {
    return { symbol: first, fn: second };
  }
  return null;
}
