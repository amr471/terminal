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
	return []string{
		norm.KindTrades, norm.KindCandles, norm.KindBook,
		norm.KindFunding, norm.KindOI, norm.KindTicker,
	}
}

// Limits: the "no per-conn stream cap, VERIFY before P1.5c" this comment
// used to carry was never resolved before P1.5c shipped — a real live run
// 2026-07-19 hit the consequence: with MaxStreamsPerConn treated as
// uncapped, 200 symbols x StreamsPerSymbol()=9 landed on ONE connection,
// and the single Manager.consume goroutine draining it (internal/conn/
// manager.go) couldn't keep up with real market throughput — hundreds of
// "dropped message; consumer too slow" warnings per second, cascading into
// spurious "sequence anomaly; resyncing" (see the emit() fix in ws.go) that
// resubscribed the whole shard mid-burst and made it worse.
//
// Fixed by giving MaxStreamsPerConn a real value: 100 (shardSize=100/9=11
// symbols/shard, shardCount=ceil(200/11)=19 shards for a full 200-symbol
// venue — coincidentally the same shard count KuCoin's own exchange-imposed
// ~100-topics/connection limit produces, and KuCoin is the one venue with
// zero drops in every live run so far, so this targets a similar per-
// connection message rate). This is a self-imposed cap for OUR consumer
// throughput, not an exchange-documented limit — Bybit's real constraints
// (verified via docs 2026-07-19) are generous enough that 19 connections is
// a non-issue: up to 1000 market-data connections per IP, and no more than
// 500 new connections per 5-minute window (~1.7/sec average) — a one-time
// startup burst of 19 dials is comfortably inside that, and any transiently
// rejected dial just retries via Manager's existing jittered backoff.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 100,
		WeightNote:        "v5 public: subscribe arg list also bounded by request byte size (~21k chars); MaxStreamsPerConn=100 is self-imposed for consumer throughput (fixed 2026-07-19), not an exchange requirement — see comment above",
	}
}

// Feeds returns the single multiplexed ws feed (trades + candles +
// tickers[funding+oi] + orderbook, all symbols). The orderbook moved into the
// ws feed at P1.5c — no more per-symbol book feeds — so a shard of symbols is
// one connection.
func (adapter) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewWSFeed(symbols, log)}
}
