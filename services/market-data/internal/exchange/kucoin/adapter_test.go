package kucoin

import "testing"

func TestAdapterBasics(t *testing.T) {
	a := Adapter()
	if a.Name() != "kucoin" {
		t.Fatalf("Name = %q", a.Name())
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "XBTUSDTM" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v; want XBTUSDTM", w, ok)
	}
	// OI is intentionally not provided by this venue (package doc).
	kinds := a.ProvidedKinds()
	if len(kinds) != 4 {
		t.Fatalf("ProvidedKinds = %v, want 4 (no oi)", kinds)
	}
	for _, k := range kinds {
		if k == "oi" {
			t.Fatal("kucoin should not advertise oi")
		}
	}
}

func TestAdapterFeeds(t *testing.T) {
	a := Adapter()
	feeds := a.Feeds([]string{"btcusdt", "ethusdt"}, testLog())
	if len(feeds) != 1 || feeds[0].Name() != "kucoin.ws" {
		t.Fatalf("Feeds = %d, want 1 kucoin.ws", len(feeds))
	}
	if feeds := a.Feeds([]string{"btcusdc"}, testLog()); len(feeds) != 0 {
		t.Fatalf("Feeds(non-usdt) = %d, want 0", len(feeds))
	}
}
