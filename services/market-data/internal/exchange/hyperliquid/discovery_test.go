package hyperliquid

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstrumentsMapsCoinsAndSkipsDelisted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		_, _ = w.Write([]byte(`{"universe":[
		  {"name":"BTC"},
		  {"name":"ETH"},
		  {"name":"OLD","isDelisted":true}]}`))
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
