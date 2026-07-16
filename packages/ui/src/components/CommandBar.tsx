'use client';

/**
 * Command bar (CLAUDE.md §5): single input, `SYMBOL FUNCTION` grammar
 * (BTC HEAT · AAPL CHART), backed by a fuzzy suggestion palette (P1.5,
 * fuzzyCommand.ts) — deterministic `parseCommand` stays the source of
 * truth for what actually submits; the palette is a typing aid on top.
 *
 * `symbols` is optional and caller-supplied (empty by default) — this
 * component doesn't know or care where they came from (a real instrument
 * list eventually, a small placeholder one for apps/web today).
 *
 * 'use client': uses useState. Never actually exercised inside a real
 * Next.js render tree until P1.3's terminal shell — added now that it is.
 */
import { useId, useMemo, useState } from 'react';
import type { Locale } from '@terminal/types';
import { parseCommand, type ParsedCommand } from '../command.js';
import { suggestionsFor, type CommandSuggestion } from '../fuzzyCommand.js';

export interface CommandBarProps {
  locale: Locale;
  /** Fired on Enter with a successfully parsed command. */
  onCommand: (command: ParsedCommand) => void;
  /** Localized placeholder; caller passes t()-resolved text. */
  placeholder?: string;
  /** Candidate symbols for the fuzzy suggestion palette (P1.5). */
  symbols?: readonly string[];
}

export function CommandBar({ onCommand, placeholder, symbols = [] }: CommandBarProps) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  // Escape dismisses the palette without touching `value`, so the user can
  // still submit their raw typed text verbatim on the next Enter. Reset
  // whenever the text actually changes, so a fresh keystroke reopens it.
  const [dismissed, setDismissed] = useState(false);
  const listboxId = useId();

  const suggestions = useMemo(
    () => (dismissed ? [] : suggestionsFor(value, symbols)),
    [dismissed, value, symbols],
  );

  function commit(command: ParsedCommand): void {
    onCommand(command);
    setValue('');
    setHighlighted(0);
    setDismissed(false);
  }

  function commitSuggestion(suggestion: CommandSuggestion): void {
    const parsed = parseCommand(suggestion.command);
    if (parsed) commit(parsed);
  }

  return (
    <div className={`t-commandbar${invalid ? ' t-commandbar--invalid' : ''}`}>
      <span className="t-commandbar__prompt" aria-hidden="true">
        ›
      </span>
      <input
        className="t-commandbar__input t-num"
        type="text"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={suggestions.length > 0 ? `${listboxId}-${highlighted}` : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value.toUpperCase());
          setInvalid(false);
          setHighlighted(0);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && suggestions.length > 0) {
            e.preventDefault();
            setHighlighted((i) => (i + 1) % suggestions.length);
            return;
          }
          if (e.key === 'ArrowUp' && suggestions.length > 0) {
            e.preventDefault();
            setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
            return;
          }
          if (e.key === 'Escape' && suggestions.length > 0) {
            e.preventDefault();
            setDismissed(true);
            return;
          }
          if (e.key !== 'Enter') return;
          const chosen = suggestions[highlighted];
          if (chosen) {
            commitSuggestion(chosen);
            return;
          }
          const parsed = parseCommand(value);
          if (parsed === null) {
            setInvalid(true);
            return;
          }
          commit(parsed);
        }}
      />
      {suggestions.length > 0 && (
        <ul className="t-commandbar__suggestions" role="listbox" id={listboxId}>
          {suggestions.map((suggestion, i) => (
            <li
              key={suggestion.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === highlighted}
              className={`t-commandbar__suggestion${
                i === highlighted ? ' t-commandbar__suggestion--active' : ''
              }`}
              onMouseDown={(e) => {
                // Keep focus in the input rather than blurring it first —
                // a plain click would fire blur (closing this list) before
                // the click's own handler runs.
                e.preventDefault();
                commitSuggestion(suggestion);
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              <span className="t-commandbar__suggestion-command">{suggestion.command}</span>
              <span className="t-commandbar__suggestion-kind">
                {suggestion.kind === 'function' ? 'FN' : 'SYM'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
