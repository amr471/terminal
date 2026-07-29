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

var (
	_ exchange.Adapter     = adapter{}
	_ exchange.VenueFeeder = adapter{}
)

// VenueFeeds returns the venue-wide 24h ticker poller (P1.5e). OKX has no
// all-market ticker ws channel, so this REST-polls the whole SWAP market in
// one request — see ticker.go and exchange.RESTTickerFeed.
func (adapter) VenueFeeds(log *slog.Logger) []conn.Feed {
	return []conn.Feed{NewTickerFeed(log)}
}

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
	// OKX exposes funding-rate and open-interest as ws channels (no poller);
	// 24h ticker stats come from the REST poller (ticker.go).
	return []string{
		norm.KindTrades, norm.KindCandles, norm.KindBook,
		norm.KindFunding, norm.KindOI, norm.KindTicker,
	}
}

// Limits: verified 2026-07-17 against OKX v5 docs that OKX itself has no
// documented cap on the *number* of simultaneous subscriptions a connection
// may hold, and that call was correct as far as it went — the 1009 bug found
// that day (message-too-big on the initial SUBSCRIBE) was fixed by chunking
// the SUBSCRIBE payload, not by sharding, and shard=1 kept working from
// OKX's side after that fix.
//
// Real bug found 2026-07-19, different from 2026-07-17's: shard=1 means all
// 200 symbols x StreamsPerSymbol()=10 worth of live traffic funnels through
// ONE connection's ONE Manager.consume goroutine (internal/conn/manager.go),
// and that goroutine can't keep up with real market throughput regardless of
// what OKX itself allows — hundreds of "dropped message; consumer too slow"
// warnings per second, cascading into spurious "sequence anomaly;
// resyncing" that made the burst worse (see the emit() fix in ws.go). OKX
// not capping subscription count doesn't mean WE shouldn't cap shard size —
// MaxStreamsPerConn=500 here is a self-imposed choice for consumer
// throughput (shardSize=500/10=50 symbols/shard, shardCount=ceil(200/50)=4
// shards for a full 200-symbol venue), independent of anything OKX
// documents. Kept deliberately smaller than Bybit's 19-shard fix (same bug,
// bybit/adapter.go): OKX's real, documented constraint is 3 new-connection
// establishments/second per IP, so a startup burst of 4 dials stays
// comfortably under that, where 19 would not — any transient rejection still
// self-heals via Manager's existing jittered backoff. The existing 4096-
// byte/message + 3-req/s subscribe-rate handling (subscribeBatches/
// subscribeAll, per-connection) is unaffected by this — smaller shards mean
// each one's SUBSCRIBE payload is smaller too, if anything easier to fit.
func (adapter) Limits() exchange.Limits {
	return exchange.Limits{
		MaxStreamsPerConn: 500,
		WeightNote:        "v5 public: no documented per-connection subscription-count cap, but MaxStreamsPerConn=500 (~4 shards) is self-imposed for consumer throughput (fixed 2026-07-19) — 4096-byte/message + 3 req/s subscribe rate limit still handled per-connection by chunked+paced SUBSCRIBE writes (verified 2026-07-17); OKX's separate 3 new-connections/sec/IP limit is why this is 4 shards, not 19 like Bybit",
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
