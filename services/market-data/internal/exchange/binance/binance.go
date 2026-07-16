// Package binance implements Binance USDT-M futures feeds on the F0.6
// conn.Feed framework (exchange-websockets skill's cheat sheet). Three Feed
// types, each its own conn.Manager per cmd/market-data/main.go:
//
//   - WSFeed ("binance.ws"): one connection, multiplexed across every
//     configured symbol, for trades + candles (all 6 timeframes) + funding
//     (markPrice carries the funding rate — no separate funding channel).
//   - BookFeed ("binance.book.{symbol}"): one connection per symbol — L2
//     gap detection needs per-symbol sequence scoping (see package doc on
//     conn.Manager.checkSeq), so this can't share WSFeed's one connection.
//   - OIFeed ("binance.oi.rest"): Binance's futures API has no open-interest
//     websocket channel, so this REST-polls all symbols on a timer.
package binance

const (
	wsBase   = "wss://fstream.binance.com/ws"
	restBase = "https://fapi.binance.com"

	exchangeName = "binance"

	// bookDepth: partial-book-depth streams offer 5/10/20; 20 gives a useful
	// top-of-book snapshot under the cache:book 50-level cap (store.bookLevels).
	// P1.5c multiplexes this into the ws feed instead of a per-symbol
	// diff-depth BookFeed so books scale to the full instrument universe.
	bookDepth = 20
)

// timeframes are Binance's own kline interval strings, which happen to be
// byte-identical to @terminal/types' TIMEFRAMES (norm.validTFs) — no mapping
// table needed, unlike Bybit/OKX.
var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
