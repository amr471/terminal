/**
 * Command bar skeleton (CLAUDE.md §5): single input, `SYMBOL FUNCTION`
 * grammar (BTC HEAT · AAPL CHART). Deterministic parse now; fuzzy palette
 * over symbols + functions lands at P1.5.
 */
import { useState } from 'react';
import type { Locale } from '@terminal/types';
import { parseCommand, type ParsedCommand } from '../command.js';

export interface CommandBarProps {
  locale: Locale;
  /** Fired on Enter with a successfully parsed command. */
  onCommand: (command: ParsedCommand) => void;
  /** Localized placeholder; caller passes t()-resolved text. */
  placeholder?: string;
}

export function CommandBar({ onCommand, placeholder }: CommandBarProps) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  return (
    <div className={`t-commandbar${invalid ? ' t-commandbar--invalid' : ''}`}>
      <span className="t-commandbar__prompt" aria-hidden="true">
        ›
      </span>
      <input
        className="t-commandbar__input t-num"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value.toUpperCase());
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const parsed = parseCommand(value);
          if (parsed === null) {
            setInvalid(true);
            return;
          }
          onCommand(parsed);
          setValue('');
        }}
      />
    </div>
  );
}
