package kucoin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstrumentsXBTAndSuffix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[
		  {"symbol":"XBTUSDTM","status":"Open","quoteCurrency":"USDT"},
		  {"symbol":"ETHUSDTM","status":"Open","quoteCurrency":"USDT"},
		  {"symbol":"XBTUSDM","status":"Open","quoteCurrency":"USD"},
		  {"symbol":"SOLUSDTM","status":"Paused","quoteCurrency":"USDT"}]}`))
	}))
	defer srv.Close()
	got, err := fetchInstruments(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	// XBTUSDTM -> btcusdt (XBT->BTC), ETHUSDTM -> ethusdt.
	if len(got) != 2 || got[0] != "btcusdt" || got[1] != "ethusdt" {
		t.Fatalf("got %v, want [btcusdt ethusdt]", got)
	}
}

func TestStreamsPerSymbol(t *testing.T) {
	if n := Adapter().StreamsPerSymbol(); n != 9 {
		t.Fatalf("StreamsPerSymbol = %d, want 9", n)
	}
}
