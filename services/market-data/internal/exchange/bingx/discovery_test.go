package bingx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstrumentsStatusAndSuffix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[
		  {"symbol":"BTC-USDT","status":1},
		  {"symbol":"ETH-USDT","status":1},
		  {"symbol":"BTC-USD","status":1},
		  {"symbol":"SOL-USDT","status":0}]}`))
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
