'use client';

/**
 * Secondary user-timezone clock (P1.4a) — sits next to StatusBar's fixed NY
 * clock, which it never touches or reads from (CLAUDE.md §5/§8's fixed-clock
 * vs. user-timezone split; the NY clock stays the session-overlap anchor).
 *
 * Self-contained: owns its own popover open/closed state locally (pure UI,
 * nothing else needs it). Only the actual timezone selection is lifted to
 * the caller via onSelectTz/onClear, since that's the piece that needs to be
 * persisted (apps/web's LiveStatusBar currently persists it to
 * localStorage — see docs/terminal-shell.md).
 *
 * Timezone list comes from Intl.supportedValuesOf('timeZone') — the full
 * IANA database, no bundled data file to keep in sync. A small fallback list
 * covers runtimes where that API is unavailable. A native <select> is used
 * deliberately instead of a custom combobox: with ~400 entries, the
 * browser's own type-ahead-search select is already accessible and requires
 * no extra a11y work, in keeping with "minimal chrome" (CLAUDE.md §5).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { Locale } from '@terminal/types';
import { t, formatTime, isValidTimezone } from '@terminal/i18n';

export interface SecondaryClockProps {
  locale: Locale;
  /** Injected for renderability/tests; ticks upstream same as StatusBar's `now`. */
  now: Date;
  /** null = no secondary clock configured yet. */
  tz: string | null;
  onSelectTz: (tz: string) => void;
  onClear: () => void;
}

const FALLBACK_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const ALL_TIMEZONES: readonly string[] =
  typeof Intl.supportedValuesOf === 'function'
    ? [...Intl.supportedValuesOf('timeZone')].sort()
    : FALLBACK_ZONES;

/** 'America/Argentina/Buenos_Aires' → 'Buenos Aires'; 'Europe/London' → 'London'. */
function cityLabel(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

export function SecondaryClock({ locale, now, tz, onSelectTz, onClear }: SecondaryClockProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const validTz = tz !== null && isValidTimezone(tz) ? tz : null;

  function closeIfFocusLeaves(event: React.FocusEvent<HTMLDivElement>): void {
    if (!containerRef.current?.contains(event.relatedTarget)) setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="t-secondary-clock"
      onBlur={closeIfFocusLeaves}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="t-secondary-clock__toggle t-num"
        aria-expanded={open}
        title={t(locale, validTz ? 'status.secondary_clock.change' : 'status.secondary_clock.add')}
        onClick={() => setOpen((current) => !current)}
      >
        {validTz ? (
          <>
            {formatTime(now.getTime(), locale, validTz)}
            <span className="t-secondary-clock__city">{cityLabel(validTz)}</span>
          </>
        ) : (
          <span className="t-secondary-clock__add">
            + {t(locale, 'status.secondary_clock.add')}
          </span>
        )}
      </button>

      {open && (
        <div className="t-secondary-clock__popover" role="dialog">
          <select
            className="t-secondary-clock__select"
            aria-label={t(locale, 'status.secondary_clock.picker_label')}
            value={validTz ?? ''}
            autoFocus
            onChange={(event) => {
              if (event.target.value) {
                onSelectTz(event.target.value);
                setOpen(false);
              }
            }}
          >
            <option value="" disabled>
              {t(locale, 'status.secondary_clock.picker_label')}
            </option>
            {ALL_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {validTz && (
            <button
              type="button"
              className="t-secondary-clock__clear"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              {t(locale, 'status.secondary_clock.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
