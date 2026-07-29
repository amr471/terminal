package binance

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// P1.5f: MAX_SYMBOLS_PER_VENUE used to keep the ALPHABETICALLY-first symbols,
// so a live run subscribed `akeusdt` but not `xrpusdt` — and since only capped
// symbols get the per-symbol funding/OI feeds, majors showed blank funding and
// open interest. Ranking by 24h quote volume puts the cap where it belongs.
func TestRankByVolumeOrdersByQuoteVolumeDesc(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v1/ticker/24hr" {
			t.Errorf("path = %s", r.URL.Path)
		}
		// Quoted and unquoted volumes both appear in the wild (flexStr).
		_, _ = w.Write([]byte(`[
		  {"symbol":"AKEUSDT","quoteVolume":"426638944"},
		  {"symbol":"BTCUSDT","quoteVolume":"10407203485.89"},
		  {"symbol":"XRPUSDT","quoteVolume":567640702.35},
		  {"symbol":"ETHUSDT","quoteVolume":"9666916703.55"}]`))
	}))
	defer srv.Close()

	in := []string{"akeusdt", "btcusdt", "xrpusdt", "ethusdt", "unlistedusdt"}
	got, err := rankByVolume(context.Background(), srv.Client(), srv.URL, in)
	if err != nil {
		t.Fatal(err)
	}
	want := "[btcusdt ethusdt xrpusdt akeusdt unlistedusdt]"
	if fmt.Sprint(got) != want {
		t.Fatalf("rankByVolume = %v, want %s", got, want)
	}
	// Nothing may be dropped — ranking is a preference, not a filter.
	if len(got) != len(in) {
		t.Fatalf("ranking dropped symbols: %v", got)
	}
}

func TestRankByVolumeErrorIsNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	if _, err := rankByVolume(context.Background(), srv.Client(), srv.URL, []string{"btcusdt"}); err == nil {
		t.Fatal("want an error so the supervisor falls back to alphabetical")
	}
}

func TestFetchInstrumentsFiltersLiveUSDTPerps(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v1/exchangeInfo" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"symbols":[
		  {"symbol":"BTCUSDT","contractType":"PERPETUAL","status":"TRADING","quoteAsset":"USDT"},
		  {"symbol":"ETHUSDT","contractType":"PERPETUAL","status":"TRADING","quoteAsset":"USDT"},
		  {"symbol":"BTCUSDT_240927","contractType":"CURRENT_QUARTER","status":"TRADING","quoteAsset":"USDT"},
		  {"symbol":"BTCUSDC","contractType":"PERPETUAL","status":"TRADING","quoteAsset":"USDC"},
		  {"symbol":"XRPUSDT","contractType":"PERPETUAL","status":"SETTLING","quoteAsset":"USDT"}]}`))
	}))
	defer srv.Close()

	got, err := fetchInstruments(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	// btcusdc is now admitted (2026-07-26): Binance lists real USDC perps and
	// the all-market ticker already reported them, so excluding them here left
	// their funding/OI permanently blank. Quarterly + SETTLING stay out.
	want := map[string]bool{"btcusdt": true, "ethusdt": true, "btcusdc": true}
	if len(got) != 3 {
		t.Fatalf("got %v, want btcusdt+ethusdt+btcusdc", got)
	}
	for _, s := range got {
		if !want[s] {
			t.Fatalf("unexpected instrument %q in %v", s, got)
		}
	}
}

func TestStreamsPerSymbol(t *testing.T) {
	// aggTrade + markPrice + 6 klines = 8. depth moved to its own /public
	// connection (DepthFeed) at the 2026-07-17 routing split and no longer
	// counts here — see discovery.go's doc comment.
	if n := Adapter().StreamsPerSymbol(); n != 8 {
		t.Fatalf("StreamsPerSymbol = %d, want 8", n)
	}
}
