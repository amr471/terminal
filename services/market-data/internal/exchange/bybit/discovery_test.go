package bybit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstruments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"result":{"list":[
		  {"symbol":"BTCUSDT","contractType":"LinearPerpetual","status":"Trading","quoteCoin":"USDT"},
		  {"symbol":"ETHUSDT","contractType":"LinearPerpetual","status":"Trading","quoteCoin":"USDT"},
		  {"symbol":"BTCPERP","contractType":"LinearPerpetual","status":"Trading","quoteCoin":"USDC"},
		  {"symbol":"BTC-01AUG25","contractType":"LinearFutures","status":"Trading","quoteCoin":"USDT"},
		  {"symbol":"OLDUSDT","contractType":"LinearPerpetual","status":"Closed","quoteCoin":"USDT"}]}}`))
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
	if n := Adapter().StreamsPerSymbol(); n != 9 {
		t.Fatalf("StreamsPerSymbol = %d, want 9", n)
	}
}
