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

// Limits: OKX public caps subscription requests per connection over time
// (documented as a rolling per-hour limit) and per-message size. VERIFY the
// current numbers before P1.5c sharding.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 0,
		WeightNote:        "v5 public: rolling per-connection subscription-request limit + per-message size cap; each timeframe is its own channel so candle subs multiply (VERIFY before P1.5c sharding)",
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
