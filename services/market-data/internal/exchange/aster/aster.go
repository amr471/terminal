// Package aster implements Aster (AsterDEX) USDT-perpetual feeds on the F0.6
// conn.Feed framework (P1.5d). Aster's API is a Binance USDT-M clone — same
// stream names (`@aggTrade`, `@kline_<tf>`, `@markPrice`, `@depth<levels>`),
// same combined-stream SUBSCRIBE method, same `/fapi/v1/*` REST surface — so
// this package mirrors `internal/exchange/binance` closely. It is kept its own
// package (rather than sharing binance's code) so the just-confirmed binance
// venue stays untouched; a future refactor could extract a shared Binance-
// dialect core if a third clone appears.
//
// Two deliberate differences from our binance package, both documented scope
// choices (same stance as P1.5a's OKX-checksum call):
//
//   - **Book uses the partial-depth snapshot stream** (`@depth20@100ms`), not
//     the diff-depth `@depth` stream + REST-snapshot/replay machine binance
//     runs. Each partial-depth message is a full top-20 snapshot, so it's
//     multiplexed into the one ws feed (no per-symbol book feed, no U/u/pu
//     gap machine) exactly like HyperLiquid/KuCoin. Top-20 is enough for the
//     cache:book first-paint and best-price (P1.7b); upgrade to diff-depth if
//     a book-driven feature ever needs full Aster depth.
//   - **Open interest** rides a REST poller against `/fapi/v1/openInterest`
//     (Binance-standard path) — VERIFY the endpoint exists on Aster; if not,
//     the poller degrades to logged errors and OI stays null (ADR-006), not a
//     crash.
package aster

const (
	wsBase   = "wss://fstream.asterdex.com/ws"
	restBase = "https://fapi.asterdex.com"

	exchangeName = "aster"

	// bookLevels: the partial-depth stream offers 5/10/20; 20 gives a useful
	// top-of-book snapshot under the cache:book 50-level cap (store.bookLevels).
	bookLevels = 20
)

// timeframes are Aster's kline interval strings — byte-identical to our own
// (and Binance's), so no mapping table is needed.
var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
