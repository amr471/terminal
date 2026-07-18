package binance

import (
	"io"
	"log/slog"
	"testing"
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
	if got := len(Adapter().ProvidedKinds()); got != 5 {
		t.Fatalf("ProvidedKinds len = %d, want 5", got)
	}
}
