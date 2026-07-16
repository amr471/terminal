package bingx

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestDataTypesMultiplex(t *testing.T) {
	dts := dataTypes([]string{"btcusdt", "ethusdt"})
	// per symbol: trade + depth + 6 klines = 8; two symbols = 16.
	if len(dts) != 16 {
		t.Fatalf("dataTypes = %d, want 16: %v", len(dts), dts)
	}
	var sawTrade, sawDepth, sawKline bool
	for _, d := range dts {
		switch {
		case d == "BTC-USDT@trade":
			sawTrade = true
		case d == "BTC-USDT@depth20@200ms":
			sawDepth = true
		case d == "ETH-USDT@kline_60min":
			sawKline = true
		}
	}
	if !sawTrade || !sawDepth || !sawKline {
		t.Fatalf("missing dataTypes: trade=%v depth=%v kline=%v", sawTrade, sawDepth, sawKline)
	}
}

func TestDataTypesSkipsUnmappable(t *testing.T) {
	if dts := dataTypes([]string{"btcusdc"}); len(dts) != 0 {
		t.Fatalf("non-usdt should yield no dataTypes, got %v", dts)
	}
}

func TestSymbolMapping(t *testing.T) {
	for n, wire := range map[string]string{"btcusdt": "BTC-USDT", "ethusdt": "ETH-USDT"} {
		if got, ok := wireSymbol(n); !ok || got != wire {
			t.Fatalf("wireSymbol(%s) = %q,%v; want %s", n, got, ok, wire)
		}
	}
	if _, ok := wireSymbol("btcusdc"); ok {
		t.Fatal("non-usdt should be unlisted")
	}
}

func TestAdapter(t *testing.T) {
	a := Adapter()
	if a.Name() != "bingx" {
		t.Fatalf("Name = %q", a.Name())
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "BTC-USDT" {
		t.Fatalf("WireSymbol = %q,%v", w, ok)
	}
	kinds := strings.Join(a.ProvidedKinds(), ",")
	// trades, candles, book — NO funding, NO oi.
	if kinds != "trades,candles,book" {
		t.Fatalf("ProvidedKinds = %q", kinds)
	}
	if feeds := a.Feeds([]string{"btcusdt"}, testLog()); len(feeds) != 1 || feeds[0].Name() != "bingx.ws" {
		t.Fatalf("Feeds = %v", feeds)
	}
	if feeds := a.Feeds([]string{"btcusdc"}, testLog()); len(feeds) != 0 {
		t.Fatalf("Feeds(non-usdt) = %v", feeds)
	}
}
