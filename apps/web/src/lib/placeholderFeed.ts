/**
 * Placeholder news-ticker headlines and mock recurring economic-calendar
 * events for P1.4's top-status-bar ticker + "next high-impact event" chip.
 * TASKS.md's own P1.4 note is explicit these ship with placeholder sources
 * first — real data wires in at P1.9 (news pipeline) and P1.11 (economic
 * calendar), at which point this whole module gets deleted, not extended.
 *
 * Kept as a plain data + pure-function module (no React, no fetch, no
 * Date.now() capture) so the "which event is next" math is unit-testable
 * the same way resize.ts/panelOrder.ts/tabOrder.ts already are in this repo.
 */
import type { Locale } from '@terminal/types';

export interface PlaceholderNewsItem {
  en: string;
  ru: string;
}

/** Illustrative only — never rendered as if it were real news. */
export const PLACEHOLDER_NEWS_ITEMS: readonly PlaceholderNewsItem[] = [
  {
    en: 'Placeholder: BTC dominance ticks up as majors consolidate',
    ru: 'Плейсхолдер: доминация BTC растёт на фоне консолидации топ-монет',
  },
  {
    en: 'Placeholder: ETH perp funding turns negative on major venues',
    ru: 'Плейсхолдер: фандинг по ETH перпетуалам ушёл в минус на крупных площадках',
  },
  {
    en: 'Placeholder: US equities open mixed ahead of the CPI print',
    ru: 'Плейсхолдер: американские акции открылись разнонаправленно перед данными по CPI',
  },
  {
    en: 'Placeholder: open interest builds across BTC options',
    ru: 'Плейсхолдер: открытый интерес по опционам на BTC растёт',
  },
];

/** Selects the locale-appropriate text for one headline. */
export function newsHeadlineFor(locale: Locale, item: PlaceholderNewsItem): string {
  return item[locale];
}

export interface PlaceholderCalendarEvent {
  /** UTC hour-of-day (0-23) this mock event recurs at, daily. */
  utcHour: number;
  en: string;
  ru: string;
}

export const PLACEHOLDER_CALENDAR_EVENTS: readonly PlaceholderCalendarEvent[] = [
  { utcHour: 1, en: 'Placeholder: Tokyo CPI release', ru: 'Плейсхолдер: публикация CPI Токио' },
  { utcHour: 12, en: 'Placeholder: US CPI release', ru: 'Плейсхолдер: публикация CPI США' },
  { utcHour: 18, en: 'Placeholder: FOMC statement', ru: 'Плейсхолдер: заявление FOMC' },
];

export interface NextPlaceholderEvent {
  /** Whole hours until the event, rounded up — never 0 (see below). */
  hoursUntil: number;
  event: PlaceholderCalendarEvent;
}

/**
 * Smallest hours-until across the (daily-recurring) placeholder calendar,
 * wrapping to tomorrow once every event's hour has already passed today.
 * Rounded up to the nearest whole hour (`Math.ceil`, floor of 1) — matches
 * `status.next_event`'s "{hours}h" phrasing and existing test expectations
 * (i18n.test.ts uses whole numbers); this is mock data, not meant to be
 * to-the-minute accurate.
 *
 * `PLACEHOLDER_CALENDAR_EVENTS` is a non-empty const, so this always
 * returns a result — no null/undefined case for callers to handle.
 */
export function nextPlaceholderEvent(now: Date): NextPlaceholderEvent {
  const nowMs = now.getTime();
  let best: NextPlaceholderEvent | undefined;

  for (const event of PLACEHOLDER_CALENDAR_EVENTS) {
    const todayAtHour = new Date(now);
    todayAtHour.setUTCHours(event.utcHour, 0, 0, 0);
    let targetMs = todayAtHour.getTime();
    if (targetMs <= nowMs) targetMs += 24 * 60 * 60 * 1000;

    const hoursUntil = Math.max(1, Math.ceil((targetMs - nowMs) / (60 * 60 * 1000)));
    if (best === undefined || hoursUntil < best.hoursUntil) best = { hoursUntil, event };
  }

  return best as NextPlaceholderEvent;
}

/** Selects the locale-appropriate name for one calendar event. */
export function calendarEventName(locale: Locale, event: PlaceholderCalendarEvent): string {
  return event[locale];
}
