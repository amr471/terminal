// Package bingx implements BingX USDT-perpetual (swapV2) feeds on the F0.6
// conn.Feed framework (P1.5d). Two things make BingX different from the other
// JSON venues:
//
//   - **Every server frame is GZIP-compressed** — the read path gunzips each
//     message before decoding (decompress, decode.go). Client→server frames
//     (subscribe) are plain JSON.
//   - **Heartbeat is a literal "Ping"/"Pong"**: the server sends a (gzipped)
//     "Ping" every ~5s and the client must reply with the text "Pong", or the
//     connection is dropped.
//
// One multiplexed connection: trades (`{symbol}@trade`) + candles
// (`{symbol}@kline_<interval>`, all timeframes) + book
// (`{symbol}@depth<level>@<interval>`, a limited snapshot — multiplexed with
// no per-symbol seq machine, same as HyperLiquid/KuCoin/Aster). Subscribe is
// one `{"id","reqType":"sub","dataType":...}` frame per topic (200 topics max
// per socket).
//
// Deliberately scoped out for this first cut (documented, same stance as
// MEXC's book/OI): **funding rate and open interest**. BingX exposes neither
// as a swapV2 websocket market channel this feed uses (they live behind REST,
// e.g. premiumIndex / openInterest), so `ProvidedKinds` lists only trades,
// candles, and book. A REST poller is the natural follow-up.
package bingx

import "strings"

const (
	wsBase       = "wss://open-api-swap.bingx.com/swap-market"
	restBase     = "https://open-api.bingx.com"
	exchangeName = "bingx"

	// bookLevel / bookInterval: the partial-depth snapshot stream offers
	// levels 5/10/20/50/100 at 100/200/500/1000ms. 20 levels @200ms is a good
	// top-of-book snapshot under the cache:book 50-level cap.
	bookLevel    = 20
	bookInterval = "200ms"
)

// klineIntervalFor maps our tf strings to BingX kline interval codes.
var klineIntervalFor = map[string]string{
	"1m": "1min", "5m": "5min", "15m": "15min", "1h": "60min", "4h": "4hour", "1d": "1day",
}

// tfForKlineInterval is klineIntervalFor's inverse, for decoding a dataType's
// kline suffix (e.g. "kline_60min") back to our tf.
var tfForKlineInterval = map[string]string{
	"1min": "1m", "5min": "5m", "15min": "15m", "60min": "1h", "4hour": "4h", "1day": "1d",
}

var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}

// wireSymbol maps our normalized symbol ("btcusdt") to BingX's hyphenated
// contract id ("BTC-USDT"). ok=false for non-USDT symbols (USDT-margined perps
// only — same hardcoded-universe stance as okx.toInstID).
func wireSymbol(symbol string) (string, bool) {
	const quote = "usdt"
	if !strings.HasSuffix(symbol, quote) || len(symbol) <= len(quote) {
		return "", false
	}
	return strings.ToUpper(symbol[:len(symbol)-len(quote)]) + "-USDT", true
}
