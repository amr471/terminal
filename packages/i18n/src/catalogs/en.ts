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
  'nav.best_price': 'Best Price',

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
  'status.secondary_clock.add': 'Add clock',
  'status.secondary_clock.change': 'Change timezone',
  'status.secondary_clock.picker_label': 'Choose a timezone',
  'status.secondary_clock.clear': 'Remove clock',

  // Data states (graceful degradation, architecture.md §5.6)
  'data.stale': 'Data delayed {age}',
  'data.feed_down': 'Feed unavailable — showing last known data',
  'data.loading': 'Loading…',
  'data.empty': 'Nothing here yet',

  // Screener (P1.6 engine, P1.7 UI)
  'screener.filter.add': 'Add filter',
  'screener.filter.add_group': 'Add group',
  'screener.filter.remove': 'Remove filter',
  'screener.filter.and': 'AND',
  'screener.filter.or': 'OR',
  'screener.save': 'Save screen',
  'screener.results': {
    one: '{count} result',
    other: '{count} results',
  },
  'screener.apply': 'Apply',
  'screener.new_screen': 'New filter',
  'screener.save_as': 'Save as…',
  'screener.save_as.placeholder': 'Screen name',
  'screener.save_as.confirm': 'Save',
  'screener.save_as.cancel': 'Cancel',
  'screener.delete': 'Delete',
  'screener.delete_confirm': 'Delete this screen?',
  'screener.export': 'Export CSV',
  'screener.export.watermark': 'Exported from TERMINAL — get your free account: {url}',
  'screener.my_screens_label': 'Screen',
  'screener.status.live': 'Live',
  'screener.columns_config': 'Columns',
  'screener.columns_config_label': 'Show/hide columns',
  'screener.exchange_filter.all': 'All exchanges',
  'screener.preset.high_volume_losers': 'High-volume losers',
  'screener.preset.negative_funding': 'Negative funding',
  'screener.preset.unusual_oi': 'Unusual open interest',
  'screener.column.symbol': 'Symbol',
  'screener.field.exchange': 'Exchange',
  'screener.field.asset_class': 'Asset class',
  'screener.field.price': 'Price',
  'screener.field.change_1h': '1h %',
  'screener.field.change_24h': '24h %',
  'screener.field.change_7d': '7d %',
  'screener.field.volume_24h': 'Volume 24h',
  'screener.field.market_cap': 'Market cap',
  'screener.field.open_interest': 'Open interest',
  'screener.field.funding_rate': 'Funding rate',
  'screener.field.volatility_24h': 'Volatility 24h',
  'screener.field.spread': 'Spread',
  'screener.op.gt': '>',
  'screener.op.gte': '≥',
  'screener.op.lt': '<',
  'screener.op.lte': '≤',
  'screener.op.eq': '=',
  'screener.op.neq': '≠',
  'screener.op.between': 'between',
  'screener.op.in': 'is one of',
  'screener.op.not_in': 'is not one of',

  // Best price board (P1.7b) — consolidated best bid/ask across venues
  'bestprice.status.live': 'Live',
  'bestprice.column.symbol': 'Symbol',
  'bestprice.column.bestBidVenue': 'Bid venue',
  'bestprice.column.bestBid': 'Best bid',
  'bestprice.column.bestBidSize': 'Bid size',
  'bestprice.column.bestAsk': 'Best ask',
  'bestprice.column.bestAskSize': 'Ask size',
  'bestprice.column.bestAskVenue': 'Ask venue',
  'bestprice.column.spread': 'Spread',
  'bestprice.column.venueCount': 'Venues',

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
  'error.GW-2006': 'This email is already registered — try signing in instead.',
  'error.generic': 'Something went wrong. Try again.',

  // Landing page (P1.2a)
  'landing.hero_kicker': 'Free · No credit card · RU/EN',
  'landing.hero_subtitle':
    'Screener, charts, liquidation maps, news, and an AI strategy desk — one dark, dense workspace built for traders who read tape, not press releases.',
  'landing.seo_description':
    'TERMINAL is a free Bloomberg-style trading terminal for crypto and stocks: real-time screener, liquidation maps, news, economic calendar, and AI-assisted strategy — in English and Russian.',
  'landing.features_heading': 'What you get',
  'landing.features.screener_title': 'Real-time screener',
  'landing.features.screener_body':
    'Sort thousands of instruments by volume, funding, open interest, and volatility — with a custom filter builder for the setups you actually trade.',
  'landing.features.liq_title': 'Liquidation maps',
  'landing.features.liq_body':
    'See where leverage clusters and where it breaks — a formula-based heatmap side by side with real on-chain positions.',
  'landing.features.ai_title': 'AI strategy desk',
  'landing.features.ai_body':
    'Describe a strategy in plain language and backtest it against real history — your own Anthropic key, never shared, never logged.',
  'landing.signup_heading': 'Create your free account',
  'landing.signup.display_name': 'Name (optional)',
  'landing.signup.submit': 'Create free account',
  'landing.signup.error_invalid_email': 'Enter a valid email address.',
  'landing.signup.error_password_too_short': 'Use at least 10 characters.',
  'landing.signup.or_continue_with': 'Or continue with',
  'landing.signup.google': 'Continue with Google',
  'landing.signup.discord': 'Continue with Discord',
  'landing.signup.telegram': 'Continue with Telegram',

  // Terminal shell (P1.3)
  'terminal.command_placeholder': 'e.g. BTC HEAT',
  'terminal.resize_handle': 'Resize panel',
  'terminal.command_not_available': "That's not built yet — coming in a later phase.",
  // terminal.panel.screener_body removed at P1.7 — the screener panel now
  // renders ScreenerPanel, not placeholder text (delete-not-extend, same
  // stance P1.4's placeholderFeed.ts follow-up note takes on placeholders).
  'terminal.panel.chart_body': 'Charts are coming soon.',
  'terminal.panel.news_body': 'News feed is coming soon.',

  // Terminal workspace tabs (P1.3a)
  'terminal.tab.list_label': 'Terminal tabs',
  'terminal.tab.new': 'New tab',
  'terminal.tab.close': 'Close tab',
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;
/** Every locale must cover every key — enforced at compile time on ru.ts. */
export type Catalog = Record<MessageKey, Message>;
