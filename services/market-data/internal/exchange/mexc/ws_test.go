package mexc

import (
	"io"
	"log/slog"
	"testing"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSymbolMapping(t *testing.T) {
	cases := map[string]string{"btcusdt": "BTC_USDT", "ethusdt": "ETH_USDT", "solusdt": "SOL_USDT"}
	for n, wire := range cases {
		if got, ok := wireSymbol(n); !ok || got != wire {
			t.Fatalf("wireSymbol(%s) = %q,%v; want %s", n, got, ok, wire)
		}
		if got := symbolFromWire(wire); got != n {
			t.Fatalf("symbolFromWire(%s) = %q; want %s", wire, got, n)
		}
	}
	if _, ok := wireSymbol("btcusdc"); ok {
		t.Fatal("non-usdt should be unlisted")
	}
}

func TestAdapterBasics(t *testing.T) {
	a := Adapter()
	if a.Name() != "mexc" {
		t.Fatalf("Name = %q", a.Name())
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "BTC_USDT" {
		t.Fatalf("WireSymbol = %q,%v", w, ok)
	}
	kinds := a.ProvidedKinds()
	// trades + candles + funding; NO book, NO oi (both scoped out).
	if len(kinds) != 3 {
		t.Fatalf("ProvidedKinds = %v, want 3", kinds)
	}
	for _, k := range kinds {
		if k == "book" || k == "oi" {
			t.Fatalf("mexc should not advertise %q", k)
		}
	}
}

func TestAdapterFeeds(t *testing.T) {
	a := Adapter()
	if feeds := a.Feeds([]string{"btcusdt", "ethusdt"}, testLog()); len(feeds) != 1 || feeds[0].Name() != "mexc.ws" {
		t.Fatalf("Feeds = %v", feeds)
	}
	if feeds := a.Feeds([]string{"btcusdc"}, testLog()); len(feeds) != 0 {
		t.Fatalf("Feeds(non-usdt) = %v, want empty", feeds)
	}
}
