// Package okx implements OKX v5 (USDT-margined perpetual swap) feeds on the
// F0.6 conn.Feed framework. Same two-Feed-type shape as bybit (OKX also
// exposes open interest over websocket, so no REST poller):
//
//   - WSFeed ("okx.ws"): trades + candles (all 6 timeframes) + funding-rate
//   - open-interest, multiplexed across every configured symbol.
//   - BookFeed ("okx.book.{symbol}"): one connection per symbol (same
//     per-symbol Manager.checkSeq scoping reasoning as the other two
//     exchanges' book feeds).
//
// OKX-specific things worth flagging up front (exchange-websockets skill:
// "VERIFY against current docs" — these are the divergences that bit past
// sessions on the other two exchanges, so documented here rather than
// discovered the hard way again):
//
//   - Perpetual data lives on a *different* instId than spot: "BTC-USDT"
//     is spot, "BTC-USDT-SWAP" is the perpetual swap this package actually
//     wants (funding/OI only exist on the SWAP instrument). instID.go's
//     toInstID/fromInstID convert between our normalized symbols and OKX's
//     "-SWAP" form; this repo's configured symbol universe is USDT-quoted
//     only (btcusdt, ethusdt, solusdt), so the split is hardcoded on that
//     assumption rather than general base/quote parsing — flagged, not
//     silently generalized.
//   - Candle payloads are positional arrays ([ts,o,h,l,c,vol,...]), not
//     named objects like Binance/Bybit.
//   - The ping/pong handshake is a literal text frame ("ping"/"pong"), not
//     a JSON message like Bybit's {"op":"ping"}.
package okx

const (
	wsBase   = "wss://ws.okx.com:8443/ws/v5/public"
	restBase = "https://www.okx.com"

	exchangeName = "okx"
)

// candleChannel maps our timeframes to OKX's channel *names* — each
// timeframe is its own channel on OKX, not a channel+arg pair.
var candleChannel = map[string]string{
	"1m": "candle1m", "5m": "candle5m", "15m": "candle15m",
	"1h": "candle1H", "4h": "candle4H", "1d": "candle1D",
}

// tfForChannel is candleChannel's inverse.
var tfForChannel = map[string]string{
	"candle1m": "1m", "candle5m": "5m", "candle15m": "15m",
	"candle1H": "1h", "candle4H": "4h", "candle1D": "1d",
}

var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
