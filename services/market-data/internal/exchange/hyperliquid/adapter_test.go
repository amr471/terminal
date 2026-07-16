package hyperliquid

import "testing"

func TestAdapterBasics(t *testing.T) {
	a := Adapter()
	if a.Name() != "hyperliquid" {
		t.Fatalf("Name = %q", a.Name())
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "BTC" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v; want BTC, true", w, ok)
	}
	if _, ok := a.WireSymbol("btcusdc"); ok {
		t.Fatal("WireSymbol(btcusdc) should be false")
	}
	if len(a.ProvidedKinds()) != 5 {
		t.Fatalf("ProvidedKinds = %v", a.ProvidedKinds())
	}
}

func TestAdapterFeedsSingleMultiplexed(t *testing.T) {
	a := Adapter()
	feeds := a.Feeds([]string{"btcusdt", "ethusdt", "solusdt"}, testLog())
	if len(feeds) != 1 || feeds[0].Name() != "hyperliquid.ws" {
		t.Fatalf("Feeds = %d feeds, want 1 hyperliquid.ws", len(feeds))
	}
	// No mappable symbol → no feed (don't register an idle connection).
	if feeds := a.Feeds([]string{"btcusdc"}, testLog()); len(feeds) != 0 {
		t.Fatalf("Feeds(non-usdt) = %d, want 0", len(feeds))
	}
}
