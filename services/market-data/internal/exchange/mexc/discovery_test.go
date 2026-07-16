package mexc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstrumentsStateAndQuote(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[
		  {"symbol":"BTC_USDT","quoteCoin":"USDT","state":0},
		  {"symbol":"ETH_USDT","quoteCoin":"USDT","state":0},
		  {"symbol":"BTC_USD","quoteCoin":"USD","state":0},
		  {"symbol":"SOL_USDT","quoteCoin":"USDT","state":3}]}`))
	}))
	defer srv.Close()
	got, err := fetchInstruments(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "btcusdt" || got[1] != "ethusdt" {
		t.Fatalf("got %v, want [btcusdt ethusdt]", got)
	}
}

func TestStreamsPerSymbol(t *testing.T) {
	if n := Adapter().StreamsPerSymbol(); n != 8 {
		t.Fatalf("StreamsPerSymbol = %d, want 8", n)
	}
}
