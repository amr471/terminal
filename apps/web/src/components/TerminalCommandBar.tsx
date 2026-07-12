'use client';

/**
 * Thin client wrapper around @terminal/ui's CommandBar. Needed because the
 * terminal page itself is a Server Component and can't pass a function
 * (onCommand) across the server/client boundary — this owns that handler
 * locally instead. Actual command execution (jump to a symbol+function
 * view) lands at P1.5; for now it's a no-op so the grammar/parsing is
 * exercised end to end without a destination to send it to yet.
 */
import { CommandBar, type ParsedCommand } from '@terminal/ui';
import type { Locale } from '@terminal/types';

export interface TerminalCommandBarProps {
  locale: Locale;
  placeholder: string;
}

export function TerminalCommandBar({ locale, placeholder }: TerminalCommandBarProps) {
  return (
    <CommandBar
      locale={locale}
      placeholder={placeholder}
      onCommand={(command: ParsedCommand) => {
        // P1.5: route this to the matching symbol+function view. Discarded
        // for now — the repo's lint config only allows console.warn/error,
        // and this isn't warning/error-worthy, so it stays silent until
        // P1.5 gives it somewhere real to go.
        void command;
      }}
    />
  );
}
