package kucoin

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is KuCoin Futures' exchange.Adapter (P1.5b). One multiplexed feed
// (the bullet handshake happens inside its Connect), so Feeds returns a single
// conn.Feed regardless of symbol count.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the KuCoin venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol maps to KuCoin's contract id ("btcusdt" -> "XBTUSDTM", applying
// the BTC->XBT rename); ok=false for non-USDT symbols.
func (adapter) WireSymbol(symbol string) (string, bool) {
	return wireSymbol(symbol)
}

// ProvidedKinds omits oi: KuCoin's OI isn't wired from the channels this feed
// uses (package doc — documented follow-up, not a silent gap).
func (adapter) ProvidedKinds() []string {
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook, norm.KindFunding}
}

// Limits: KuCoin caps subscriptions per connection (documented ~100 topics per
// connection at the time of writing) and rotates the ws token every 24h.
// VERIFY current numbers before P1.5c sharding.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 100,
		WeightNote:        "~100 topics/connection, bullet token valid 24h (connection must be re-established), 300 msgs/10s send cap (VERIFY before P1.5c sharding)",
	}
}

// Feeds returns the single multiplexed feed, or nil if no symbol maps.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	if !anyMapped(symbols) {
		return nil
	}
	return []conn.Feed{NewWSFeed(symbols, log)}
}

func anyMapped(symbols []string) bool {
	for _, s := range symbols {
		if _, ok := wireSymbol(strings.ToLower(s)); ok {
			return true
		}
	}
	return false
}
