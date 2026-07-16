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

// Limits: Binance futures combined streams cap one connection at 200 streams;
// 300 new connections per 5 min per IP. VERIFY before P1.5c leans on these.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 200,
		WeightNote:        "USDT-M futures: <=200 streams/conn, <=300 new conns / 5min / IP; REST /openInterest weight 1 (VERIFY before P1.5c sharding)",
	}
}

// Feeds returns the multiplexed ws feed (trades+candles+funding+partial-depth
// book, all symbols) and the REST OI poller (futures has no OI ws channel).
// Books were multiplexed into the ws feed at P1.5c — no more per-symbol book
// feeds — so a shard of symbols is one ws connection + shared OI poll.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewWSFeed(symbols, log), NewOIFeed(symbols, log)}
}
