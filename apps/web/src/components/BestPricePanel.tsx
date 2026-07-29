'use client';

/**
 * The consolidated best-price panel (P1.7b, CLAUDE.md §6.1's scalpboard.io-
 * style view), replacing the placeholder TerminalWorkspace.tsx would
 * otherwise render for `kind === 'bestprice'`. Much thinner than
 * ScreenerPanel (P1.7 UI): no saved-screens picker, no filter builder, no
 * column config, no export — there's nothing to configure (bestPriceHub.ts
 * has no per-subscriber definition, every subscriber sees the same
 * consolidated rows, tightest spread first). Just a live subscription
 * (useBestPriceSubscription) feeding @terminal/ui's BestPriceTable, plus a
 * health badge matching ScreenerPanel's own live/connecting/down states.
 */
import type { Locale } from '@terminal/types';
import { ALL_BEST_PRICE_COLUMNS, BestPriceTable, HealthBadge, type BestPriceColumnId } from '@terminal/ui';
import { t, type MessageKey } from '@terminal/i18n';
import { useBestPriceSubscription } from '../lib/useBestPriceSubscription';

const COLUMN_LABEL_KEY: Record<BestPriceColumnId, MessageKey> = {
  symbol: 'bestprice.column.symbol',
  bestBidVenue: 'bestprice.column.bestBidVenue',
  bestBid: 'bestprice.column.bestBid',
  bestBidSize: 'bestprice.column.bestBidSize',
  bestAsk: 'bestprice.column.bestAsk',
  bestAskSize: 'bestprice.column.bestAskSize',
  bestAskVenue: 'bestprice.column.bestAskVenue',
  spread: 'bestprice.column.spread',
  venueCount: 'bestprice.column.venueCount',
};

export interface BestPricePanelProps {
  locale: Locale;
  /**
   * Restricts the panel to a single symbol's cross-venue rows — added
   * 2026-07-18 for the Screener-row-click detail view (docs/best-price.md).
   * bestPriceHub.ts has no per-subscriber filter on the wire (every
   * subscriber gets the same consolidated stream), so this filters the
   * already-live `rows` client-side; omitted/undefined shows every symbol,
   * same as before.
   */
  symbolFilter?: string;
}

export function BestPricePanel({ locale, symbolFilter }: BestPricePanelProps) {
  const { rows, status } = useBestPriceSubscription();
  const visibleRows = symbolFilter ? rows.filter((row) => row.symbol === symbolFilter) : rows;

  const healthState = status === 'live' ? 'LIVE' : status === 'error' ? 'DOWN' : 'DEGRADED';
  const healthLabel =
    status === 'live'
      ? t(locale, 'bestprice.status.live')
      : status === 'error'
        ? t(locale, 'data.feed_down')
        : t(locale, 'data.loading');

  return (
    <div className="t-screener">
      <div className="t-screener__toolbar">
        <HealthBadge state={healthState} label={healthLabel} />
      </div>
      <div className="t-screener__table-wrap">
        <BestPriceTable
          rows={visibleRows}
          columns={ALL_BEST_PRICE_COLUMNS}
          columnLabel={(id) => t(locale, COLUMN_LABEL_KEY[id])}
          locale={locale}
          emptyLabel={t(locale, 'data.empty')}
        />
      </div>
    </div>
  );
}
