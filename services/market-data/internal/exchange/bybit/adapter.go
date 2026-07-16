package bybit

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is Bybit's exchange.Adapter (P1.5b) — names the venue and assembles
// the feeds ws.go/book.go already build; no decode/book code moves here.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the Bybit venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol upper-cases: Bybit v5 linear uses "BTCUSDT". Lists this repo's
// full USDT-quoted universe.
func (adapter) WireSymbol(symbol string) (string, bool) {
	if symbol == "" {
		return "", false
	}
	return strings.ToUpper(symbol), true
}

func (adapter) ProvidedKinds() []string {
	// tickers channel carries funding AND oi (package doc) — both provided.
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook, norm.KindFunding, norm.KindOI}
}

// Limits: Bybit v5 public caps a subscription request's arg list by total
// byte size (~21k chars) rather than a fixed stream count; no per-conn stream
// cap we hit at MVP scale. VERIFY before P1.5c.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 0,
		WeightNote:        "v5 public: subscribe arg list bounded by request byte size (~21k chars), no fixed stream cap; connection limits apply per IP (VERIFY before P1.5c sharding)",
	}
}

// Feeds returns the single multiplexed ws feed (trades + candles +
// tickers[funding+oi] + orderbook, all symbols). The orderbook moved into the
// ws feed at P1.5c — no more per-symbol book feeds — so a shard of symbols is
// one connection.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewWSFeed(symbols, log)}
}
