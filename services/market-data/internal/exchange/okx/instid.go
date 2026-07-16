package okx

import (
	"strings"

	"github.com/terminal/market-data/internal/norm"
)

// toInstID converts our normalized symbol ("btcusdt") to OKX's perpetual
// swap instId ("BTC-USDT-SWAP"). Hardcoded to USDT-quoted symbols — this
// repo's configured universe (package doc) — rather than general
// base/quote parsing; returns ok=false for anything that doesn't end in
// "usdt" so callers can skip/log rather than build a malformed instId.
func toInstID(symbol string) (instID string, ok bool) {
	const quote = "usdt"
	if !strings.HasSuffix(symbol, quote) || len(symbol) <= len(quote) {
		return "", false
	}
	base := symbol[:len(symbol)-len(quote)]
	return strings.ToUpper(base) + "-USDT-SWAP", true
}

// fromInstID is toInstID's inverse: "BTC-USDT-SWAP" -> "btcusdt".
func fromInstID(instID string) string {
	trimmed := strings.TrimSuffix(instID, "-SWAP")
	return norm.NormalizeSymbol(trimmed)
}
