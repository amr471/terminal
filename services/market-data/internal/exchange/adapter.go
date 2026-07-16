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
