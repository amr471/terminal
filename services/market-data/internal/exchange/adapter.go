// Package exchange defines the pluggable per-venue adapter contract (P1.5b)
// that the market-data service uses to treat every exchange uniformly. See
// docs/exchange-adapters.md for the design and why this is a thin
// registry+metadata seam rather than a generic feed engine (P1.5a found the
// venues don't share enough decode/subscribe/book-gap logic to abstract that
// part).
//
// This package imports only internal/conn — never a venue subpackage. Venue
// packages import this one for the Adapter interface, so the registry is
// assembled in cmd/market-data (importing both) to avoid an import cycle.
package exchange

import (
	"context"
	"log/slog"

	"github.com/terminal/market-data/internal/conn"
)

// Adapter is one venue's plug into the market-data service. Everything
// venue-specific (JSON decode, subscribe args, ping loop, book gap/resync)
// stays inside the venue's own package; the Adapter standardizes only what
// downstream code needs to enumerate venues, map symbols across them, and
// budget connections.
type Adapter interface {
	// Name is the venue id used in md.{exchange}.* channels and health
	// reports, e.g. "binance". Lowercase, stable.
	Name() string

	// WireSymbol maps a normalized symbol ("btcusdt") to this venue's
	// canonical instrument id and reports whether the venue lists it at all.
	// ok=false means "this venue doesn't carry this symbol" — the caller
	// skips it rather than building a feed that can never subscribe (OKX
	// non-USDT, a coin outside HyperLiquid's universe, etc.). Per-channel
	// stream naming (Binance's lowercase stream vs REST form) stays inside
	// the venue package; this returns the one canonical id used for
	// cross-venue correlation (P1.7b/P2.2).
	WireSymbol(symbol string) (wire string, ok bool)

	// ProvidedKinds lists the norm.Kind* channels this venue emits (trades,
	// candles, book, funding, oi). Lets a consumer know not to expect, say,
	// funding from a venue that doesn't publish it.
	ProvidedKinds() []string

	// Limits reports this venue's connection/subscription budget — the input
	// P1.5c uses to shard the full instrument universe across connections.
	Limits() Limits

	// Feeds builds every conn.Feed for the given normalized symbols: the
	// adapter owns its own ws/book/(oi) topology and skips symbols it
	// doesn't list (WireSymbol ok=false). The caller registers whatever is
	// returned, one conn.Manager per feed.
	Feeds(symbols []string, log *slog.Logger) []conn.Feed

	// StreamsPerSymbol is how many multiplexed ws streams one symbol adds to
	// a connection (trades + candles + book + funding/oi that ride the ws
	// feed — NOT separate REST pollers). The P1.5c supervisor sizes a shard
	// at Limits().MaxStreamsPerConn / StreamsPerSymbol. Return a positive
	// count even for venues whose MaxStreamsPerConn is 0 (unbounded), so the
	// number is available if a cap is added later.
	StreamsPerSymbol() int

	// Instruments returns the venue's live tradable symbols — normalized
	// (norm.NormalizeSymbol form, USDT perpetuals only) — from its REST
	// instrument-list endpoint. The P1.5c supervisor polls this to discover
	// the universe and detect listings/delistings. A transient error is the
	// caller's to retry on the next cycle; it must not be fatal.
	Instruments(ctx context.Context) ([]string, error)
}

// VenueFeeder is an OPTIONAL Adapter extension (P1.5e) for feeds that are
// venue-wide singletons rather than per-shard: one connection covering every
// symbol at once, independent of how the universe is sharded.
//
// The motivating case is the all-market 24h ticker stream (Binance's
// `!ticker@arr`, Bybit's `tickers.*`, etc.), which delivers 24h volume and
// percent change for EVERY symbol on the venue in a single subscription.
// Routing that through Feeds() would open one duplicate copy per shard, so the
// supervisor starts VenueFeeds() exactly once per venue instead, under the
// venue context — it lives for the process, unaffected by shard churn as
// symbols list and delist.
//
// Adapters that don't implement this are unaffected (plain type assertion).
type VenueFeeder interface {
	// VenueFeeds builds the venue-wide singleton feeds. Called once per venue
	// at startup; the returned feeds get one conn.Manager each, exactly like
	// Feeds()' results.
	VenueFeeds(log *slog.Logger) []conn.Feed
}

// VolumeRanker is an OPTIONAL Adapter extension (P1.5f) letting a venue order
// its own instrument list by importance, so MAX_SYMBOLS_PER_VENUE keeps the
// symbols that matter.
//
// Why: the cap previously kept the ALPHABETICALLY-first N symbols, which on a
// live run meant `akeusdt` was subscribed while `xrpusdt` was not. Only capped
// symbols get the per-symbol feeds (funding via markPrice, open interest via
// the REST poller), so funding/OI were populated for obscure "a" coins and
// blank for BTC-adjacent majors past the mid-alphabet cutoff. Ranking by 24h
// quote volume puts the cap where it belongs.
//
// Adapters that don't implement this keep the deterministic alphabetical
// fallback — correctness never depends on this call succeeding, and a transient
// REST failure must not churn the universe (the supervisor keeps the previous
// order in that case).
type VolumeRanker interface {
	// RankByVolume returns `symbols` reordered most-important-first, typically
	// by 24h quote volume from the venue's REST 24h-ticker endpoint. It may
	// return fewer symbols than given (unranked ones are appended by the
	// caller, never dropped). An error means "couldn't rank right now" and is
	// the caller's to fall back on, not fatal.
	RankByVolume(ctx context.Context, symbols []string) ([]string, error)
}

// Limits describes a venue's connection budget. Zero values mean "unknown /
// not a constraint at our scale" — P1.5a's handful of symbols never
// approaches any real cap; P1.5c is where these numbers start mattering.
type Limits struct {
	// MaxStreamsPerConn is how many subscriptions one multiplexed connection
	// can carry before the venue drops or rejects. P1.5c splits feeds across
	// this many streams per connection. 0 = unknown/unbounded for our use.
	MaxStreamsPerConn int
	// WeightNote is a freeform human note on the venue's rate-limit model
	// (request weights, connection caps, message-rate limits) — a pointer for
	// whoever wires P1.5c, not machine-read.
	WeightNote string
}

// Registry is the ordered set of venue adapters the service runs. Assembled
// in cmd/market-data/main.go (see package doc on the import-cycle reason).
type Registry struct {
	adapters []Adapter
	byName   map[string]Adapter
}

// NewRegistry builds a registry from adapters in the given order. It panics
// on a duplicate Name — a programming error in the main.go assembly, caught
// at startup rather than silently shadowing a venue.
func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{
		adapters: make([]Adapter, 0, len(adapters)),
		byName:   make(map[string]Adapter, len(adapters)),
	}
	for _, a := range adapters {
		if _, dup := r.byName[a.Name()]; dup {
			panic("exchange: duplicate adapter name " + a.Name())
		}
		r.adapters = append(r.adapters, a)
		r.byName[a.Name()] = a
	}
	return r
}

// Adapters returns the registered adapters in registration order.
func (r *Registry) Adapters() []Adapter { return r.adapters }

// ByName looks up a single adapter; ok=false if no venue by that name.
func (r *Registry) ByName(name string) (Adapter, bool) {
	a, ok := r.byName[name]
	return a, ok
}

// Feeds is the flattened set of conn.Feeds across every registered venue for
// the given symbols — what cmd/market-data registers with the manager.
func (r *Registry) Feeds(symbols []string, log *slog.Logger) []conn.Feed {
	var out []conn.Feed
	for _, a := range r.adapters {
		out = append(out, a.Feeds(symbols, log)...)
	}
	return out
}
