package okx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInstrumentsFiltersLiveUSDTSwaps(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[
		  {"instId":"BTC-USDT-SWAP","state":"live","settleCcy":"USDT"},
		  {"instId":"ETH-USDT-SWAP","state":"live","settleCcy":"USDT"},
		  {"instId":"BTC-USD-SWAP","state":"live","settleCcy":"BTC"},
		  {"instId":"XRP-USDT-SWAP","state":"suspend","settleCcy":"USDT"}]}`))
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
	if n := Adapter().StreamsPerSymbol(); n != 10 {
		t.Fatalf("StreamsPerSymbol = %d, want 10", n)
	}
}
