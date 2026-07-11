/**
 * English message catalog — the reference catalog: its keys define the
 * MessageKey type. Every user-facing string in the product lives in a catalog,
 * never in component code (CLAUDE.md §8).
 *
 * Params use {name} placeholders, filled by t(). Plural-sensitive messages
 * provide `one/few/many/other` variants and are resolved via plural().
 */
/** CLDR plural forms; `other` is the mandatory fallback. */
export interface PluralForms {
  one?: string;
  few?: string;
  many?: string;
  other: string;
}
export type Message = string | PluralForms;

export const en = {
  // App chrome
  'app.name': 'TERMINAL',
  'app.tagline': 'The free Bloomberg-grade terminal for crypto & stocks',

  // Navigation rail
  'nav.screener': 'Screener',
  'nav.charts': 'Charts',
  'nav.liq_map': 'Liquidation Map',
  'nav.news': 'News',
  'nav.calendar': 'Calendar',
  'nav.journal': 'Journal',
  'nav.alerts': 'Alerts',
  'nav.marketplace': 'Marketplace',

  // Status bar
  'status.ny_time': 'New York',
  'status.session.sydney': 'Sydney',
  'status.session.tokyo': 'Tokyo',
  'status.session.london': 'London',
  'status.session.new_york': 'New York',
  'status.session.open': 'Open',
  'status.session.closed': 'Closed',
  'status.session.overlap': 'Overlap',
  'status.next_event': 'Next high-impact event in {hours}h',

  // Data states (graceful degradation, architecture.md §5.6)
  'data.stale': 'Data delayed {age}',
  'data.feed_down': 'Feed unavailable — showing last known data',
  'data.loading': 'Loading…',
  'data.empty': 'Nothing here yet',

  // Screener
  'screener.filter.add': 'Add filter',
  'screener.filter.and': 'AND',
  'screener.filter.or': 'OR',
  'screener.save': 'Save screen',
  'screener.results': {
    one: '{count} result',
    other: '{count} results',
  },

  // Alerts
  'alerts.create': 'Create alert',
  'alerts.fired': {
    one: '{count} alert fired',
    other: '{count} alerts fired',
  },
  'alerts.suppressed_stale': 'Alert paused: data feed is not live',

  // Auth
  'auth.sign_up': 'Sign up',
  'auth.sign_in': 'Sign in',
  'auth.email': 'Email',
  'auth.password': 'Password',

  // Errors (referenced by stable code, architecture.md §5.7)
  'error.GW-2001': 'Sign-in failed. Check your email and password.',
  'error.GW-2004': 'Too many requests — slow down a little.',
  'error.generic': 'Something went wrong. Try again.',
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;
/** Every locale must cover every key — enforced at compile time on ru.ts. */
export type Catalog = Record<MessageKey, Message>;
