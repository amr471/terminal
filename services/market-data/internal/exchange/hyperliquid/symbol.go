package hyperliquid

import (
	"strings"

	"github.com/terminal/market-data/internal/norm"
)

// coinFor converts our normalized symbol ("btcusdt") to HyperLiquid's bare
// base coin ("BTC") and reports whether it maps. HL perps are USD-margined
// and keyed by coin, so we drop the "usdt" quote suffix; ok=false for
// anything not USDT-quoted (this repo's universe is USDT-quoted — same
// hardcoded-on-that-assumption stance as okx.toInstID, flagged not
// generalized).
func coinFor(symbol string) (coin string, ok bool) {
	const quote = "usdt"
	if !strings.HasSuffix(symbol, quote) || len(symbol) <= len(quote) {
		return "", false
	}
	return strings.ToUpper(symbol[:len(symbol)-len(quote)]), true
}

// symbolFor is coinFor's inverse: "BTC" -> "btcusdt". Used when decoding an
// incoming message's coin back to our normalized symbol.
func symbolFor(coin string) string {
	return norm.NormalizeSymbol(coin) + "usdt"
}
