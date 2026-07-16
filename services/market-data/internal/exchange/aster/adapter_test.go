package aster

import "testing"

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
	if len(a.ProvidedKinds()) != 5 {
		t.Fatalf("ProvidedKinds = %v, want 5", a.ProvidedKinds())
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
