package aster

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is Aster's exchange.Adapter (P1.5d). Two feeds: the multiplexed ws
// feed and a REST OI poller (Aster has no OI websocket channel, like Binance).
type adapter struct{}

var (
	_ exchange.Adapter     = adapter{}
	_ exchange.VenueFeeder = adapter{}
)

// VenueFeeds returns the venue-wide 24h ticker poller (P1.5e) — one REST call
// covering every instrument, so volume_24h/change_24h populate immediately
// instead of waiting on our own candle history. See ticker.go.
func (adapter) VenueFeeds(log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewTickerFeed(log)}
}

// Adapter returns the Aster venue adapter for cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol upper-cases: Aster uses "BTCUSDT" as the REST/display id (ws
// stream names lower-case it again). Lists this repo's USDT-quoted universe.
func (adapter) WireSymbol(symbol string) (string, bool) {
	if symbol == "" {
		return "", false
	}
	return strings.ToUpper(symbol), true
}

func (adapter) ProvidedKinds() []string {
	return []string{
		norm.KindTrades, norm.KindCandles, norm.KindBook,
		norm.KindFunding, norm.KindOI, norm.KindTicker,
	}
}

// Limits mirror Binance-family caps: a single connection can carry up to 200
// streams (VERIFY Aster's exact number before P1.5c sharding).
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 200,
		WeightNote:        "Binance-compatible: <=200 streams/conn, connection valid 24h then auto-disconnect, 10 incoming msgs/sec cap (VERIFY before P1.5c sharding)",
	}
}

// Feeds returns the multiplexed ws feed + the REST OI poller. Empty if no
// symbol maps (so the caller registers nothing).
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	if len(symbols) == 0 {
		return nil
	}
	return []conn.Feed{NewWSFeed(symbols, log), NewOIFeed(symbols, log)}
}
