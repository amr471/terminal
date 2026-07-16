// Package kucoin implements KuCoin Futures (USDT-margined perpetual) feeds on
// the F0.6 conn.Feed framework (P1.5b — the second venue added through the
// exchange adapter contract; docs/exchange-adapters.md). KuCoin is the
// interesting CEX for proving the adapter's *construction* seam, because you
// cannot just dial a fixed URL:
//
//   - CONNECT is a two-step "bullet" handshake. A REST POST to
//     /api/v1/bullet-public returns a short-lived token plus a server list;
//     you dial the returned endpoint with "?token=...&connectId=...". All of
//     this happens inside WSFeed.Connect (bullet.go) — nothing outside this
//     package knows the handshake exists, which is exactly the point.
//   - BTC is "XBT": the perpetual is XBTUSDTM, not BTCUSDTM. wireSymbol maps
//     it (and ETHUSDTM/SOLUSDTM), so the XBT quirk stays contained here.
//   - Order book uses the level2Depth50 channel — full 50-level snapshots
//     pushed ~every 100ms — so, like HyperLiquid, the book is multiplexed
//     into the one connection with no per-symbol sequence/gap machine (the
//     alternative level2 delta channel would need a REST-snapshot bootstrap
//     and seq tracking; scoped out here, could be added if a book-driven
//     feature needs sub-100ms freshness).
//   - Candles (limitCandle channel) carry no closed-bucket flag, so final
//     detection is open-time rollover (candleTracker, decode.go), same as HL.
//
// Deliberately scoped for this venue (documented, not silently dropped —
// same stance as P1.5a's OKX-checksum / market_cap calls):
//
//   - TRADE quantities are in CONTRACTS (lot size), not base-asset units, as
//     KuCoin sends them; converting to base needs each contract's multiplier
//     (REST /contracts). Emitted verbatim for now; ProvidedKinds still lists
//     trades. VERIFY/normalize before any size-sensitive consumer (P1.7b).
//   - OPEN INTEREST is not wired here (KuCoin exposes it via a separate
//     snapshot/REST path, not the channels above), so ProvidedKinds omits oi.
//     A REST OI poller (like Binance's) is the natural follow-up — the adapter
//     already supports multi-feed topology.
package kucoin

import "strings"

const (
	restBase     = "https://api-futures.kucoin.com"
	bulletPath   = "/api/v1/bullet-public"
	exchangeName = "kucoin"

	// bookDepth: level2Depth50 gives 50 levels/side, matching the
	// cache:book:* cap (store.bookLevels).
	bookDepth = 50
)

// granularityFor maps our tf strings to KuCoin Futures limitCandle type codes.
var granularityFor = map[string]string{
	"1m": "1min", "5m": "5min", "15m": "15min", "1h": "1hour", "4h": "4hour", "1d": "1day",
}

// tfForGranularity is granularityFor's inverse, for decoding a limitCandle
// topic suffix (e.g. "XBTUSDTM_1hour") back to our tf.
var tfForGranularity = map[string]string{
	"1min": "1m", "5min": "5m", "15min": "15m", "1hour": "1h", "4hour": "4h", "1day": "1d",
}

var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}

// wireSymbol maps our normalized symbol ("btcusdt") to KuCoin's futures
// contract id ("XBTUSDTM"), applying the BTC->XBT rename. ok=false for
// non-USDT symbols (this package handles USDT-margined perps only — same
// hardcoded-universe stance as okx.toInstID).
func wireSymbol(symbol string) (string, bool) {
	const quote = "usdt"
	if !strings.HasSuffix(symbol, quote) || len(symbol) <= len(quote) {
		return "", false
	}
	base := strings.ToUpper(symbol[:len(symbol)-len(quote)])
	if base == "BTC" {
		base = "XBT"
	}
	return base + "USDTM", true
}

// symbolFromWire is wireSymbol's inverse: "XBTUSDTM" -> "btcusdt".
func symbolFromWire(wire string) string {
	base := strings.TrimSuffix(wire, "USDTM")
	if base == "XBT" {
		base = "BTC"
	}
	return strings.ToLower(base) + "usdt"
}
