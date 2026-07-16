// Package bybit implements Bybit v5 (linear/USDT-perpetual) feeds on the
// F0.6 conn.Feed framework. Two Feed types (unlike Binance's three — Bybit's
// "tickers" channel carries both funding rate AND open interest together,
// so no REST OI poller is needed here):
//
//   - WSFeed ("bybit.ws"): one connection, multiplexed across every
//     configured symbol, for trades + candles (all 6 timeframes) + tickers
//     (funding + OI).
//   - BookFeed ("bybit.book.{symbol}"): one connection per symbol, same
//     per-symbol-scoping reasoning as binance.BookFeed (package doc there).
//     Bybit's own recommended gap-recovery is a plain resubscribe (the
//     channel replays a fresh snapshot), not a separate REST call like
//     Binance — see book.go and docs/market-data-feeds.md.
package bybit

const (
	wsBase   = "wss://stream.bybit.com/v5/public/linear"
	restBase = "https://api.bybit.com"

	exchangeName = "bybit"

	// bookDepth: Bybit's linear orderbook channel offers 1/50/200/500 levels;
	// 50 matches the cache:book:* depth cap (store.bookLevels) without
	// over-subscribing.
	bookDepth = 50
)

// intervalFor maps @terminal/types' TIMEFRAMES to Bybit's own kline interval
// codes (architecture.md §4.1's tf values are NOT what Bybit expects on the
// wire — exchange-websockets skill flags exactly this kind of divergence).
var intervalFor = map[string]string{
	"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D",
}

// tfFor is intervalFor's inverse, used when decoding an incoming kline
// message back to our own timeframe string.
var tfFor = map[string]string{
	"1": "1m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", "D": "1d",
}

// timeframes lists our own tf strings in intervalFor's key order, for
// building the subscribe arg list.
var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
