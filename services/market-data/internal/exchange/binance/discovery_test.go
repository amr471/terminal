package binance

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
	want := map[string]bool{"btcusdt": true, "ethusdt": true}
	if len(got) != 2 {
		t.Fatalf("got %v, want exactly btcusdt+ethusdt", got)
	}
	for _, s := range got {
		if !want[s] {
			t.Fatalf("unexpected instrument %q in %v", s, got)
		}
	}
}

func TestStreamsPerSymbol(t *testing.T) {
	if n := Adapter().StreamsPerSymbol(); n != 9 {
		t.Fatalf("StreamsPerSymbol = %d, want 9", n)
	}
}
