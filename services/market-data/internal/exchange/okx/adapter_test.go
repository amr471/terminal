package okx

import (
	"io"
	"log/slog"
	"testing"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestAdapterWireSymbolSkipsNonUSDT(t *testing.T) {
	a := Adapter()
	if got, ok := a.WireSymbol("btcusdt"); !ok || got != "BTC-USDT-SWAP" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v; want BTC-USDT-SWAP, true", got, ok)
	}
	if _, ok := a.WireSymbol("btcusdc"); ok {
		t.Fatalf("WireSymbol(btcusdc) should be unlisted (OKX package is USDT-only)")
	}
}

func TestAdapterFeedsSingleMultiplexed(t *testing.T) {
	a := Adapter()
	// One multiplexed ws feed regardless of symbol count; books are now the
	// books5 channel inside it, not per-symbol feeds. Unmappable symbols
	// (btcusdc) are filtered inside the WSFeed's subscribe args.
	feeds := a.Feeds([]string{"btcusdt", "ethusdt", "btcusdc"}, testLog())
	if len(feeds) != 1 || feeds[0].Name() != "okx.ws" {
		t.Fatalf("Feeds = %d, want 1 okx.ws", len(feeds))
	}
}

func TestAdapterName(t *testing.T) {
	if Adapter().Name() != "okx" {
		t.Fatalf("Name = %q, want okx", Adapter().Name())
	}
}
