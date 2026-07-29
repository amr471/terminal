package aster

import (
	"testing"

	"github.com/terminal/market-data/internal/exchange"
)

func TestAdapterBasics(t *testing.T) {
	a := Adapter()
	if a.Name() != "aster" {
		t.Fatalf("Name = %q", a.Name())
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "BTCUSDT" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v; want BTCUSDT", w, ok)
	}
	if _, ok := a.WireSymbol(""); ok {
		t.Fatal("empty symbol should be unlisted")
	}
	// 6 since P1.5e added norm.KindTicker (the venue-wide 24h ticker poller).
	if len(a.ProvidedKinds()) != 6 {
		t.Fatalf("ProvidedKinds = %v, want 6", a.ProvidedKinds())
	}
}

// The 24h ticker is a VENUE-WIDE singleton, not per-shard: one REST call
// already covers every instrument, so a per-shard copy would be duplication.
func TestAdapterVenueFeeds(t *testing.T) {
	vf, ok := Adapter().(exchange.VenueFeeder)
	if !ok {
		t.Fatal("aster adapter should implement exchange.VenueFeeder")
	}
	feeds := vf.VenueFeeds(testLog())
	if len(feeds) != 1 || feeds[0].Name() != "aster.ticker.rest" {
		t.Fatalf("VenueFeeds = %+v, want one aster.ticker.rest", feeds)
	}
	for _, f := range Adapter().Feeds([]string{"btcusdt"}, testLog()) {
		if f.Name() == "aster.ticker.rest" {
			t.Error("ticker poller must not be per-shard")
		}
	}
}

func TestAdapterFeedTopology(t *testing.T) {
	a := Adapter()
	feeds := a.Feeds([]string{"btcusdt", "ethusdt"}, testLog())
	// ws + oi = 2, regardless of symbol count (ws is multiplexed).
	if len(feeds) != 2 {
		t.Fatalf("Feeds = %d, want 2 (ws + oi)", len(feeds))
	}
	if feeds[0].Name() != "aster.ws" || feeds[1].Name() != "aster.oi.rest" {
		t.Fatalf("feed names = %q, %q", feeds[0].Name(), feeds[1].Name())
	}
	if feeds := a.Feeds(nil, testLog()); feeds != nil {
		t.Fatalf("Feeds(nil) = %v, want nil", feeds)
	}
}
