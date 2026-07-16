package hyperliquid

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is HyperLiquid's exchange.Adapter (P1.5b). One multiplexed feed, so
// Feeds returns a single conn.Feed regardless of symbol count.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the HyperLiquid venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol maps our normalized symbol to HL's canonical instrument id. HL
// keys perps by bare coin ("BTC"), so that's the id used for cross-venue
// correlation (P1.7b); ok=false for non-USDT symbols HL doesn't carry here.
func (adapter) WireSymbol(symbol string) (string, bool) {
	return coinFor(symbol)
}

func (adapter) ProvidedKinds() []string {
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook, norm.KindFunding, norm.KindOI}
}

// Limits: HL multiplexes everything on one connection and documents IP-based
// rate limits rather than a per-connection stream cap. VERIFY current numbers
// before P1.5c leans on this.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 0,
		WeightNote:        "one multiplexed ws connection; IP-based rate limits, subscriptions sent individually (VERIFY before P1.5c sharding)",
	}
}

// Feeds returns the single multiplexed feed. Nil (empty) if no symbol maps to
// an HL coin, so the caller registers nothing rather than an idle connection.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	if !anyMapped(symbols) {
		return nil
	}
	return []conn.Feed{NewWSFeed(symbols, log)}
}

func anyMapped(symbols []string) bool {
	for _, s := range symbols {
		if _, ok := coinFor(strings.ToLower(s)); ok {
			return true
		}
	}
	return false
}
