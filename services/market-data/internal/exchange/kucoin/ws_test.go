package kucoin

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestTopicsMultiplex(t *testing.T) {
	tp := topics([]string{"btcusdt", "ethusdt"})
	// execution + level2Depth50 + instrument + limitCandle = 4 topic strings.
	if len(tp) != 4 {
		t.Fatalf("topics = %d, want 4: %v", len(tp), tp)
	}
	var exec, candle string
	for _, s := range tp {
		if strings.HasPrefix(s, "/contractMarket/execution:") {
			exec = s
		}
		if strings.HasPrefix(s, "/contractMarket/limitCandle:") {
			candle = s
		}
	}
	if exec != "/contractMarket/execution:XBTUSDTM,ETHUSDTM" {
		t.Fatalf("execution topic = %q", exec)
	}
	// two symbols x six timeframes = 12 comma-joined symbol_granularity pairs.
	pairs := strings.Split(strings.TrimPrefix(candle, "/contractMarket/limitCandle:"), ",")
	if len(pairs) != 12 {
		t.Fatalf("candle pairs = %d, want 12: %v", len(pairs), pairs)
	}
	if !contains(pairs, "XBTUSDTM_1hour") || !contains(pairs, "ETHUSDTM_1day") {
		t.Fatalf("missing expected candle pair in %v", pairs)
	}
}

func TestTopicsSkipsUnmappable(t *testing.T) {
	if tp := topics([]string{"btcusdc"}); tp != nil {
		t.Fatalf("non-usdt should yield no topics, got %v", tp)
	}
}

func TestSymbolMapping(t *testing.T) {
	cases := map[string]string{"btcusdt": "XBTUSDTM", "ethusdt": "ETHUSDTM", "solusdt": "SOLUSDTM"}
	for norm, wire := range cases {
		if got, ok := wireSymbol(norm); !ok || got != wire {
			t.Fatalf("wireSymbol(%s) = %q, %v; want %s", norm, got, ok, wire)
		}
		if got := symbolFromWire(wire); got != norm {
			t.Fatalf("symbolFromWire(%s) = %q, want %s", wire, got, norm)
		}
	}
	if _, ok := wireSymbol("btcusdc"); ok {
		t.Fatal("btcusdc should be unlisted")
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
