// Package binance implements Binance USDT-M futures feeds on the F0.6
// conn.Feed framework (exchange-websockets skill's cheat sheet). Three Feed
// types, each its own conn.Manager per cmd/market-data/main.go:
//
//   - WSFeed ("binance.ws"): one connection to the /market route, multiplexed
//     across every configured symbol, for trades, candles (all 6 timeframes),
//     and funding (markPrice carries the funding rate — no separate funding
//     channel).
//   - DepthFeed ("binance.ws.depth"): one connection to the /public route,
//     multiplexed across every configured symbol, for the partial-book-depth
//     snapshot stream. Split from WSFeed at the 2026-07-17 routing migration
//     below — depth and market data now live on different base URLs and a
//     single connection can only receive one route's data.
//   - OIFeed ("binance.oi.rest"): Binance's futures API has no open-interest
//     websocket channel, so this REST-polls all symbols on a timer.
//
// Real bug found + fixed 2026-07-17: this package used to dial a single
// unrouted wss://fstream.binance.com/ws connection carrying aggTrade +
// markPrice + kline + depth together. Binance split that base URL into
// dedicated /public, /market, /private routes (see "Important WebSocket
// Change Notice" in the USDS-M futures docs) with legacy unrouted URLs
// decommissioned 2026-04-23 — after that date they either silently stop
// pushing non-Public channels or, per a live production run today, get
// rejected outright with `websocket: close 1008 (policy violation): Invalid
// request`. Fixed by splitting into two feeds pointed at the correct routed
// bases (see docs/market-data-feeds.md).
package binance

const (
	// wsMarketBase carries aggTrade + markPrice + kline (Binance's "regular
	// market data" routing group). wsPublicBase carries the partial-book-depth
	// snapshot (Binance's "high-frequency public market data" group). See the
	// package doc above — these replace the single legacy wsBase.
	wsMarketBase = "wss://fstream.binance.com/market/ws"
	wsPublicBase = "wss://fstream.binance.com/public/ws"
	restBase     = "https://fapi.binance.com"

	exchangeName = "binance"

	// bookDepth: partial-book-depth streams offer 5/10/20; 20 gives a useful
	// top-of-book snapshot under the cache:book 50-level cap (store.bookLevels).
	// P1.5c multiplexes this into a depth-dedicated ws feed (DepthFeed, split
	// out again 2026-07-17 for the /public routing move above) instead of a
	// per-symbol diff-depth BookFeed, so books scale to the full instrument
	// universe.
	bookDepth = 20
)

// timeframes are Binance's own kline interval strings, which happen to be
// byte-identical to @terminal/types' TIMEFRAMES (norm.validTFs) — no mapping
// table needed, unlike Bybit/OKX.
var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
