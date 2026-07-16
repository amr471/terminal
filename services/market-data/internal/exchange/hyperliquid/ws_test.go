package hyperliquid

import (
	"io"
	"log/slog"
	"testing"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSubscriptionsPerCoin(t *testing.T) {
	subs := subscriptions([]string{"btcusdt", "ethusdt"})
	// per coin: trades + l2Book + activeAssetCtx + 6 candle tfs = 9; two coins = 18.
	if len(subs) != 18 {
		t.Fatalf("subs = %d, want 18", len(subs))
	}
	// Spot-check a couple of shapes.
	var sawTrades, sawCandle bool
	for _, s := range subs {
		if s["type"] == "trades" && s["coin"] == "BTC" {
			sawTrades = true
		}
		if s["type"] == "candle" && s["coin"] == "ETH" && s["interval"] == "1h" {
			sawCandle = true
		}
	}
	if !sawTrades || !sawCandle {
		t.Fatalf("missing expected subs: trades=%v candle=%v", sawTrades, sawCandle)
	}
}

func TestSubscriptionsSkipsUnmappable(t *testing.T) {
	if subs := subscriptions([]string{"btcusdc"}); len(subs) != 0 {
		t.Fatalf("non-usdt symbol should yield no subs, got %d", len(subs))
	}
}

func TestSymbolRoundTrip(t *testing.T) {
	coin, ok := coinFor("btcusdt")
	if !ok || coin != "BTC" {
		t.Fatalf("coinFor(btcusdt) = %q, %v", coin, ok)
	}
	if got := symbolFor("BTC"); got != "btcusdt" {
		t.Fatalf("symbolFor(BTC) = %q", got)
	}
	if _, ok := coinFor("usdt"); ok {
		t.Fatal("coinFor(usdt) should be false (empty base)")
	}
}
