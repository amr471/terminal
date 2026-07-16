package okx

import "testing"

func TestToInstID(t *testing.T) {
	id, ok := toInstID("btcusdt")
	if !ok || id != "BTC-USDT-SWAP" {
		t.Fatalf("id=%q ok=%v, want BTC-USDT-SWAP/true", id, ok)
	}
}

func TestToInstID_NonUSDTQuoteNotOK(t *testing.T) {
	if _, ok := toInstID("btcbusd"); ok {
		t.Fatal("expected ok=false for a non-USDT-quoted symbol")
	}
}

func TestFromInstID(t *testing.T) {
	if got := fromInstID("BTC-USDT-SWAP"); got != "btcusdt" {
		t.Errorf("got %q, want btcusdt", got)
	}
}

func TestToInstID_FromInstID_RoundTrip(t *testing.T) {
	for _, sym := range []string{"btcusdt", "ethusdt", "solusdt"} {
		id, ok := toInstID(sym)
		if !ok {
			t.Fatalf("toInstID(%q) not ok", sym)
		}
		if got := fromInstID(id); got != sym {
			t.Errorf("round trip %q -> %q -> %q", sym, id, got)
		}
	}
}
