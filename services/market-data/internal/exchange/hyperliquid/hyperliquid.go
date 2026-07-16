// Package hyperliquid implements HyperLiquid perpetual feeds on the F0.6
// conn.Feed framework (P1.5b — the first venue added through the exchange
// adapter contract; docs/exchange-adapters.md). HyperLiquid is a DEX perp
// venue, structurally different from the three CEX venues P1.5a built:
//
//   - ONE multiplexed connection carries everything. Unlike Binance/Bybit/OKX,
//     the order book is multiplexed into the same feed as trades/candles/ctx
//     rather than split into per-symbol book feeds. That split existed only
//     for exchange-sequence gap detection (docs/market-data-feeds.md); HL's
//     l2Book is a *full-snapshot* feed (each message is the whole book, pushed
//     on each block ≥0.5s since the last), so there is no per-book sequence to
//     gap-check and nothing to Resync — the WSFeed's own monotonic counter is
//     the only Seq, exactly like the other venues' multiplexed *.ws feeds.
//   - Symbols are the bare base coin ("BTC", not "BTCUSDT"): HL perps are
//     USD-margined and identified by coin. coinFor/symbolFor convert.
//   - Candle/context numeric fields arrive as JSON numbers *or* strings
//     depending on field; flexStr (decode.go) accepts both and carries them
//     as string decimals per architecture.md §4.3.
//   - No candle "closed" flag on the wire, so final-bucket detection is done
//     by open-time rollover (candleTracker, decode.go) rather than a confirm
//     field — same normalized result, different source.
//
// Funding AND open interest both come from the single activeAssetCtx channel
// (like Bybit's tickers), so no REST poller is needed.
//
// VERIFY markers (exchange-websockets skill convention) — re-check against
// live docs before relying on these: trade side letter mapping ("B"→buy),
// and that activeAssetCtx carries no per-message event timestamp (we stamp
// receive time into ts).
package hyperliquid

const (
	wsBase  = "wss://api.hyperliquid.xyz/ws"
	infoURL = "https://api.hyperliquid.xyz/info"

	exchangeName = "hyperliquid"
)

// timeframes are our own tf strings; HyperLiquid's candle intervals are
// byte-identical ("1m".."1d"), so no mapping table is needed (like Binance).
var timeframes = []string{"1m", "5m", "15m", "1h", "4h", "1d"}
