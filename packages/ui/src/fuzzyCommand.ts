/**
 * Fuzzy suggestion palette over the command bar's `SYMBOL FUNCTION` grammar
 * (command.ts) — P1.5. Deliberately domain-agnostic about *which* symbols
 * exist: the function-code list (COMMAND_FUNCTIONS) is intrinsic to this
 * package, but the symbol universe is supplied by the caller (apps/web
 * passes a small placeholder list today — see lib/placeholderSymbols.ts —
 * until P1.6/P1.5a give it a real one). Keeps packages/ui from depending on
 * apps/web's placeholder content, same boundary TabBar/ResizableColumns
 * already draw against apps/web-owned state.
 */
import { COMMAND_FUNCTIONS, type CommandFunction } from './command.js';

export interface CommandSuggestion {
  /** Stable React key. */
  id: string;
  kind: 'function' | 'symbol';
  /** The token being matched against — a function code or a symbol. */
  label: string;
  /** The full command string that, if submitted, parses via parseCommand. */
  command: string;
}

/**
 * Subsequence fuzzy match, case-insensitive. `null` when `query` isn't a
 * subsequence of `target`; otherwise a score where lower is a better
 * match — a prefix match scores best (0), followed by matches that start
 * earlier and skip fewer characters getting there. Deliberately simple
 * (the candidate lists here are tiny — 7 function codes plus a handful of
 * symbols) rather than a full edit-distance/Smith-Waterman scorer.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toUpperCase();
  const t = target.toUpperCase();
  if (q.length === 0) return 0;
  if (t.startsWith(q)) return 0;

  const firstChar = q[0];
  if (firstChar === undefined) return 0;
  const firstMatchIndex = t.indexOf(firstChar);
  if (firstMatchIndex === -1) return null;

  let searchFrom = 0;
  let skipped = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, searchFrom);
    if (at === -1) return null;
    skipped += at - searchFrom;
    searchFrom = at + 1;
  }
  return 1 + firstMatchIndex + skipped;
}

/** Ranks `candidates` by `fuzzyScore` against their `label`, best first. */
export function rankSuggestions(
  query: string,
  candidates: readonly CommandSuggestion[],
  limit = 8,
): CommandSuggestion[] {
  const scored: { suggestion: CommandSuggestion; score: number }[] = [];
  for (const suggestion of candidates) {
    const score = fuzzyScore(query, suggestion.label);
    if (score !== null) scored.push({ suggestion, score });
  }
  scored.sort((a, b) => a.score - b.score || a.suggestion.label.localeCompare(b.suggestion.label));
  return scored.slice(0, limit).map((s) => s.suggestion);
}

function functionCandidates(commandPrefix?: string): CommandSuggestion[] {
  return (Object.keys(COMMAND_FUNCTIONS) as CommandFunction[]).map((fn) => ({
    id: `fn:${fn}`,
    kind: 'function',
    label: fn,
    command: commandPrefix ? `${commandPrefix} ${fn}` : fn,
  }));
}

function symbolCandidates(symbols: readonly string[]): CommandSuggestion[] {
  return symbols.map((symbol) => ({
    id: `symbol:${symbol}`,
    kind: 'symbol',
    label: symbol,
    command: symbol,
  }));
}

/**
 * Builds the ranked suggestion list for the command bar's current raw
 * input, tokenizing the same way `parseCommand` ultimately will:
 *
 *  - Empty input → no suggestions.
 *  - One token, still being typed (no trailing space) → fuzzy-match both
 *    symbols and functions (either could be what the first token becomes).
 *  - One token with a trailing space, or two tokens → the first token is
 *    treated as the symbol prefix; suggestions are functions only (fuzzy
 *    matched against the second token, or all of them if it's empty),
 *    each carrying the full `SYMBOL FN` command string.
 *  - More than two tokens → no suggestions (parseCommand rejects these too).
 */
export function suggestionsFor(
  input: string,
  symbols: readonly string[],
  limit = 8,
): CommandSuggestion[] {
  const trimmedStart = input.replace(/^\s+/, '');
  const tokens = trimmedStart.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const trailingSpace = /\s$/.test(trimmedStart);
  if (tokens.length === 1 && !trailingSpace) {
    const query = tokens[0]!;
    return rankSuggestions(query, [...symbolCandidates(symbols), ...functionCandidates()], limit);
  }
  if (tokens.length > 2) return [];

  const symbolToken = tokens[0]!;
  const fnQuery = tokens[1] ?? '';
  const candidates = functionCandidates(symbolToken);
  return fnQuery === '' ? candidates.slice(0, limit) : rankSuggestions(fnQuery, candidates, limit);
}
