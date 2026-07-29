/**
 * Per-venue "open the real trading page" URL builder — added 2026-07-18 for
 * the Screener's exchange badge and the Best Price table's bid/ask venue
 * badges (docs/best-price.md, docs/screener-ui.md): clicking a venue name
 * should open that exchange's own site for this exact symbol in a new tab,
 * not just our internal cross-venue detail view.
 *
 * Pure string templating, verified against each venue's real URL scheme
 * 2026-07-18 (not guessed) — see the per-venue comments below for the
 * confirmed pattern. Every venue here is USDT-margined-perp-only in this
 * app's tracked universe (CLAUDE.md §6.12's eight default venues), and our
 * internal symbol is always lowercase base+quote concatenated with no
 * separator (`norm.NormalizeSymbol`, services/market-data), so `splitUsdt`
 * below is the one join point every venue's template needs.
 */
import { EXCHANGES, type Exchange } from './market.js';

function isExchange(value: string): value is Exchange {
  return (EXCHANGES as readonly string[]).includes(value);
}

/** Splits a normalized "btcusdt"-shaped symbol into its uppercase base —
 * every tracked symbol is USDT-quoted (services/market-data's discovery/
 * adapter code filters to USDT pairs before ever normalizing), so the quote
 * is always known and never needs to travel with the row data itself. */
function baseAsset(symbol: string): string {
  const lower = symbol.toLowerCase();
  return (lower.endsWith('usdt') ? lower.slice(0, -4) : lower).toUpperCase();
}

/** KuCoin's own market symbol for USDT perpetuals: BTC is spelled "XBT"
 * (KuCoin's one legacy renamed asset — services/market-data/internal/
 * exchange/kucoin/kucoin.go's `wireSymbol`, ported here since that mapping
 * is Go-only and not reachable from the frontend), every other asset keeps
 * its normal ticker, and every symbol gets a trailing "M" for the perpetual
 * contract (e.g. ETHUSDT -> ETHUSDTM). */
function kucoinWireSymbol(symbol: string): string {
  const base = baseAsset(symbol);
  return `${base === 'BTC' ? 'XBT' : base}USDTM`;
}

/**
 * Returns the venue's real trading-page URL for this symbol, or `null` for
 * an unrecognized venue (defensive — venue strings on `BestPriceRow`/
 * `ScreenerRow` come from live server data, not a closed enum at the type
 * level). Callers should render a plain (non-link) badge when this is null.
 */
export function exchangeTradeUrl(venue: string, symbol: string): string | null {
  if (!isExchange(venue)) return null;
  const base = baseAsset(symbol);
  const upper = symbol.toUpperCase();
  switch (venue) {
    // https://www.binance.com/en/futures/BTCUSDT
    case 'binance':
      return `https://www.binance.com/en/futures/${upper}`;
    // https://www.bybit.com/trade/usdt/BTCUSDT
    case 'bybit':
      return `https://www.bybit.com/trade/usdt/${upper}`;
    // https://www.okx.com/trade-swap/btc-usdt-swap
    case 'okx':
      return `https://www.okx.com/trade-swap/${base.toLowerCase()}-usdt-swap`;
    // https://app.hyperliquid.xyz/trade/BTC — base asset only, no quote.
    case 'hyperliquid':
      return `https://app.hyperliquid.xyz/trade/${base}`;
    // https://www.kucoin.com/trade/futures/XBTUSDTM
    case 'kucoin':
      return `https://www.kucoin.com/trade/futures/${kucoinWireSymbol(symbol)}`;
    // https://www.asterdex.com/en/trade/pro/futures/BTCUSDT
    case 'aster':
      return `https://www.asterdex.com/en/trade/pro/futures/${upper}`;
    // https://www.mexc.com/futures/BTC_USDT
    case 'mexc':
      return `https://www.mexc.com/futures/${base}_USDT`;
    // https://bingx.com/en/perpetual/BTC-USDT
    case 'bingx':
      return `https://bingx.com/en/perpetual/${base}-USDT`;
  }
}
