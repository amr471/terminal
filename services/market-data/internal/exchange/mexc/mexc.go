// Package mexc implements MEXC Futures (USDT-margined perpetual) feeds on the
// F0.6 conn.Feed framework (P1.5d). MEXC's futures/contract websocket is plain
// JSON (`wss://contract.mexc.com/edge`) — the protobuf format is MEXC *spot*
// only, a distinction worth stating because it's easy to conflate. Each
// subscribe carries `"gzip": false` so responses arrive as plain JSON with no
// decompression.
//
// One multiplexed connection: trades (`sub.deal`) + candles (`sub.kline`, all
// timeframes) + funding (`sub.funding.rate`), across every configured symbol.
// Ping is client-driven (`{"method":"ping"}` → `{"channel":"pong"}`).
//
// Deliberately scoped for this first cut (documented, not silent — same stance
// as P1.5a's OKX-checksum / KuCoin's OI):
//
//   - **Order book is not wired.** MEXC's only native depth channel
//     (`push.depth`) is *incremental* (version-keyed 200ms deltas) with no
//     native full-snapshot variant, so a correct book needs a REST-snapshot
//     bootstrap + version-continuity state machine (like binance's, but keyed
//     on `version`). Scoped out here; `ProvidedKinds` omits `book`. Follow-up.
//   - **Open interest is not wired.** MEXC exposes OI via the `push.tickers`
//     / contract-data channels, not a per-symbol OI stream this feed uses;
//     `ProvidedKinds` omits `oi`. Follow-up (could ride tickers or REST).
//   - **Trade quantities are in CONTRACTS** (lot size), emitted verbatim — the
//     same base-unit normalization gap as KuCoin (needs the contract
//     multiplier from REST). VERIFY before a size-sensitive consumer (P1.7b).
package mexc

import "strings"

const (
	wsBase       = "wss://contract.mexc.com/edge"
	restBase     = "https://contract.mexc.com"
	exchangeName = "mexc"
)

// intervalFor maps our tf strings to MEXC's kline interval codes.
var intervalFor = map[string]string{
	"1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1",
}

// tfForInterval is intervalFor's inverse, for decoding an incoming kline's
// `interval` field back to our tf.
var tfForInterval = map[string]string{
	"Min1": "1m", "Min5": "5m", "Min15": "15m", "Min60": "1h", "Hour4": "4h", "Day1": "1d",
}

var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}

// wireSymbol maps our normalized symbol ("btcusdt") to MEXC's contract id
// ("BTC_USDT"). ok=false for non-USDT symbols (this package handles
// USDT-margined perps only — same hardcoded-universe stance as okx.toInstID).
func wireSymbol(symbol string) (string, bool) {
	const quote = "usdt"
	if !strings.HasSuffix(symbol, quote) || len(symbol) <= len(quote) {
		return "", false
	}
	return strings.ToUpper(symbol[:len(symbol)-len(quote)]) + "_USDT", true
}

// symbolFromWire is wireSymbol's inverse: "BTC_USDT" -> "btcusdt".
func symbolFromWire(wire string) string {
	return strings.ToLower(strings.ReplaceAll(wire, "_", ""))
}
