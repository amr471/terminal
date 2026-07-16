package mexc

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is MEXC Futures' exchange.Adapter (P1.5d). One multiplexed feed.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the MEXC venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol maps to MEXC's contract id ("btcusdt" -> "BTC_USDT"); ok=false
// for non-USDT symbols.
func (adapter) WireSymbol(symbol string) (string, bool) {
	return wireSymbol(symbol)
}

// ProvidedKinds omits book and oi (package doc): MEXC's depth is
// incremental-only (scoped out) and OI isn't wired from the channels used.
func (adapter) ProvidedKinds() []string {
	return []string{norm.KindTrades, norm.KindCandles, norm.KindFunding}
}

// Limits: MEXC caps a single connection at 30 channels — the tightest of any
// venue so far, so P1.5c will shard MEXC sooner than the others. Symbol count
// × (deal + funding + 6 klines = 8) crosses 30 at 4 symbols, so the static
// 3-symbol MVP (24 channels) fits one connection; the full universe will not.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 30,
		WeightNote:        "30 channels/connection hard cap (multiple connections required beyond ~3 symbols at 8 channels each); JSON with gzip:false (VERIFY before P1.5c sharding)",
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
