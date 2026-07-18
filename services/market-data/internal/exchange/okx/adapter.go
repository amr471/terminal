package okx

import (
	"log/slog"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is OKX's exchange.Adapter (P1.5b) — names the venue and assembles
// the feeds ws.go/book.go already build; instId conversion and decode stay in
// instid.go/decode.go unchanged.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the OKX venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol maps to OKX's perpetual swap instId ("btcusdt" ->
// "BTC-USDT-SWAP"); ok=false for anything not USDT-quoted, since this
// package only handles USDT swaps (instid.go). That's the same skip that
// NewBookFeed already applies — surfaced here so downstream code can see
// which symbols OKX carries without instantiating a feed.
func (adapter) WireSymbol(symbol string) (string, bool) {
	return toInstID(symbol)
}

func (adapter) ProvidedKinds() []string {
	// OKX exposes funding-rate and open-interest as ws channels (no poller).
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook, norm.KindFunding, norm.KindOI}
}

// Limits: verified 2026-07-17 against OKX v5 docs (the VERIFY this comment
// used to carry was never resolved before P1.5c shipped, and a real run that
// day hit the consequence — see the bug note below). OKX has no documented
// cap on the *number* of simultaneous subscriptions a connection may hold —
// unlike Binance's explicit 1024-streams/conn — so MaxStreamsPerConn stays 0
// (shardSize treats that as uncapped, giving OKX one shard per venue). The
// real per-connection constraints are a 4096-byte cap on any single SUBSCRIBE
// message's arg payload and a 3-requests/second subscribe rate limit (480/hr
// total); ws.go's subscribeBatches + subscribeAll respect both by chunking
// and pacing the writes, so shard size doesn't need to shrink to work around
// them.
//
// Real bug found + fixed 2026-07-17: with MaxStreamsPerConn treated as
// uncapped and 200 symbols x StreamsPerSymbol()=10 in one shard, WSFeed used
// to send all ~2000 args in a single SUBSCRIBE message — ~10x over the
// 4096-byte limit — and OKX rejected the connection outright with
// `websocket: close 1009 (message too big)`. Fixed in ws.go/decode.go, not
// here: this file's shard-sizing story turned out to be correct all along.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 0,
		WeightNote:        "v5 public: no documented per-connection subscription-count cap; 4096-byte/message + 3 req/s subscribe rate limit instead, handled by chunked+paced SUBSCRIBE writes (verified 2026-07-17)",
	}
}

// Feeds returns the single multiplexed ws feed (trades+candles+funding+OI+
// books5 snapshot book, all symbols). Books moved into the ws feed via the
// books5 snapshot channel at P1.5c — no more per-symbol book feeds — so a
// shard of symbols is one connection. The WSFeed skips symbols that don't map
// to a USDT swap instId internally (subscribeArgsFor).
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewWSFeed(symbols, log)}
}
