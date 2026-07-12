/**
 * Left icon rail (CLAUDE.md §5): Screener · Charts · Liquidation Map · News
 * · Calendar · Journal · Alerts · Marketplace. Presentational and
 * server-safe — no client-only hooks. The caller (a Server Component) knows
 * the active section from the URL and passes it in, rather than this
 * component reaching for usePathname() and forcing a 'use client' boundary.
 */
import type { Locale } from '@terminal/types';
import { t, type MessageKey } from '@terminal/i18n';

export const RAIL_SECTIONS = [
  'screener',
  'charts',
  'liq_map',
  'news',
  'calendar',
  'journal',
  'alerts',
  'marketplace',
] as const;
export type RailSection = (typeof RAIL_SECTIONS)[number];

const LABEL_KEY: Record<RailSection, MessageKey> = {
  screener: 'nav.screener',
  charts: 'nav.charts',
  liq_map: 'nav.liq_map',
  news: 'nav.news',
  calendar: 'nav.calendar',
  journal: 'nav.journal',
  alerts: 'nav.alerts',
  marketplace: 'nav.marketplace',
};

/** One small inline glyph per section — no icon-library dependency. */
function RailIcon({ section }: { section: RailSection }) {
  const common = {
    viewBox: '0 0 16 16',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (section) {
    case 'screener':
      return (
        <svg {...common}>
          <path d="M2 3h12M2 8h12M2 13h8" />
        </svg>
      );
    case 'charts':
      return (
        <svg {...common}>
          <path d="M2 13V9M6 13V5M10 13V7M14 13V3" />
        </svg>
      );
    case 'liq_map':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="5" height="5" />
          <rect x="9" y="2" width="5" height="5" />
          <rect x="2" y="9" width="5" height="5" />
          <rect x="9" y="9" width="5" height="5" />
        </svg>
      );
    case 'news':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" />
          <path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="11" />
          <path d="M2 6.5h12M5 2v3M11 2v3" />
        </svg>
      );
    case 'journal':
      return (
        <svg {...common}>
          <path d="M4 2h8v12H4a1.5 1.5 0 0 1 0-3h8" />
        </svg>
      );
    case 'alerts':
      return (
        <svg {...common}>
          <path d="M8 2.5c-2 0-3.2 1.6-3.2 3.6v2.4L3.5 11h9L11.2 8.5V6.1C11.2 4.1 10 2.5 8 2.5z" />
          <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
        </svg>
      );
    case 'marketplace':
      return (
        <svg {...common}>
          <path d="M2.5 5.5 3.5 2h9l1 3.5M2.5 5.5h11M2.5 5.5 3 13.5h10l.5-8" />
        </svg>
      );
  }
}

export interface IconRailProps {
  locale: Locale;
  /** Which section's route we're currently on; undefined = none highlighted. */
  activeSection?: RailSection;
  /** Builds each item's href from its section id, e.g. (s) => `/${locale}/terminal/${s}`. */
  hrefFor: (section: RailSection) => string;
}

export function IconRail({ locale, activeSection, hrefFor }: IconRailProps) {
  return (
    <nav className="t-rail" aria-label={t(locale, 'app.name')}>
      <ul className="t-rail__list">
        {RAIL_SECTIONS.map((section) => {
          const active = section === activeSection;
          const label = t(locale, LABEL_KEY[section]);
          return (
            <li key={section}>
              <a
                href={hrefFor(section)}
                className={`t-rail__item${active ? ' t-rail__item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={label}
              >
                <RailIcon section={section} />
                <span className="t-rail__label">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
