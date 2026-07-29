package binance

import (
	"io"
	"log/slog"
	"testing"

	"github.com/terminal/market-data/internal/exchange"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestAdapterWireSymbol(t *testing.T) {
	a := Adapter()
	if got, ok := a.WireSymbol("btcusdt"); !ok || got != "BTCUSDT" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v; want BTCUSDT, true", got, ok)
	}
	if _, ok := a.WireSymbol(""); ok {
		t.Fatalf("WireSymbol(\"\") should be false")
	}
}

func TestAdapterFeedTopology(t *testing.T) {
	a := Adapter()
	// ws (market: trades+candles+funding) + ws.depth (public: partial-depth
	// book) + oi = 3, regardless of symbol count — books are no longer
	// per-symbol feeds (P1.5c), and depth split off ws into its own routed
	// connection at the 2026-07-17 /public vs /market migration.
	feeds := a.Feeds([]string{"btcusdt", "ethusdt", "solusdt"}, testLog())
	if len(feeds) != 3 {
		t.Fatalf("Feeds len = %d, want 3 (ws + ws.depth + oi)", len(feeds))
	}
	if feeds[0].Name() != "binance.ws" || feeds[1].Name() != "binance.ws.depth" || feeds[2].Name() != "binance.oi.rest" {
		t.Fatalf("unexpected feeds: %q, %q, %q", feeds[0].Name(), feeds[1].Name(), feeds[2].Name())
	}
}

func TestAdapterProvidedKinds(t *testing.T) {
	// 6 since P1.5e added norm.KindTicker (the all-market 24h ticker feed).
	if got := len(Adapter().ProvidedKinds()); got != 6 {
		t.Fatalf("ProvidedKinds len = %d, want 6", got)
	}
}

// The all-market ticker is a VENUE-WIDE singleton, not a per-shard feed:
// `!ticker@arr` already covers every symbol, so routing it through Feeds()
// would open one duplicate connection per shard (see ticker.go).
func TestAdapterVenueFeeds(t *testing.T) {
	vf, ok := Adapter().(exchange.VenueFeeder)
	if !ok {
		t.Fatal("binance adapter should implement exchange.VenueFeeder")
	}
	feeds := vf.VenueFeeds(testLog())
	if len(feeds) != 1 || feeds[0].Name() != "binance.ws.ticker" {
		t.Fatalf("VenueFeeds = %+v, want one binance.ws.ticker", feeds)
	}
	// And it must NOT also appear in the per-shard feed set.
	for _, f := range Adapter().Feeds([]string{"btcusdt"}, testLog()) {
		if f.Name() == "binance.ws.ticker" {
			t.Error("ticker feed must not be per-shard — it would be duplicated per shard")
		}
	}
}
