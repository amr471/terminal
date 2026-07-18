package binance

import (
	"log/slog"
	"strings"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// adapter is Binance's exchange.Adapter (P1.5b). It only names the venue and
// assembles the feeds this package already builds — all decode/book-gap logic
// stays in ws.go/book.go/oi.go unchanged.
type adapter struct{}

var _ exchange.Adapter = adapter{}

// Adapter returns the Binance venue adapter for the registry in
// cmd/market-data/main.go.
func Adapter() exchange.Adapter { return adapter{} }

func (adapter) Name() string { return exchangeName }

// WireSymbol upper-cases: Binance USDT-M futures uses "BTCUSDT" as the REST/
// display id (the ws stream names lower-case it again inside ws.go/book.go).
// Binance lists this repo's whole USDT-quoted universe, so ok is always true
// for a non-empty symbol.
func (adapter) WireSymbol(symbol string) (string, bool) {
	if symbol == "" {
		return "", false
	}
	return strings.ToUpper(symbol), true
}

func (adapter) ProvidedKinds() []string {
	return []string{norm.KindTrades, norm.KindCandles, norm.KindBook, norm.KindFunding, norm.KindOI}
}

// Limits: verified 2026-07-17 against the live USDS-M futures docs (the
// prior 200 figure was stale — VERIFY had been left unresolved since P1.5c
// and a real run that day hit the consequence: repeated `websocket: close
// 1008 (policy violation): Invalid request`). Current docs state a single
// connection can listen to up to 1024 streams; 300 new connections per 5
// min per IP is unchanged. See package doc in binance.go for the routing
// split (the actual cause of the 1008s) found alongside this.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 1024,
		WeightNote:        "USDT-M futures: <=1024 streams/conn (verified 2026-07-17, was stale at 200), <=300 new conns / 5min / IP; REST /openInterest weight 1",
	}
}

// Feeds returns the two multiplexed ws feeds — WSFeed (trades+candles+
// funding on /market) and DepthFeed (partial-depth book on /public), split
// 2026-07-17 because Binance now routes them to different base URLs (package
// doc, binance.go) — plus the REST OI poller (futures has no OI ws channel).
// Books were multiplexed out of per-symbol feeds at P1.5c; a shard of
// symbols is now two ws connections + one shared OI poll.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewWSFeed(symbols, log), NewDepthFeed(symbols, log), NewOIFeed(symbols, log)}
}
