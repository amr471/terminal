package bingx

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is BingX's exchange.Adapter (P1.5d). One multiplexed feed.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the BingX venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol maps to BingX's hyphenated contract id ("btcusdt" -> "BTC-USDT");
// ok=false for non-USDT symbols.
func (adapter) WireSymbol(symbol string) (string, bool) {
	return wireSymbol(symbol)
}

// ProvidedKinds omits funding and oi (package doc): BingX exposes neither as a
// swapV2 websocket market channel this feed uses.
func (adapter) ProvidedKinds() []string {
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook}
}

// Limits: a BingX socket caps at 200 topics; 60 sockets per IP. At 8 topics/
// symbol (trade + depth + 6 klines) that's ~25 symbols per socket — P1.5c will
// shard the full universe accordingly.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 200,
		WeightNote:        "200 topics/socket, 60 sockets/IP; gzip frames + Ping/Pong heartbeat (VERIFY before P1.5c sharding)",
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
