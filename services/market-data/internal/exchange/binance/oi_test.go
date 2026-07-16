package binance

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

func TestOIFeed_PollOnce_EmitsPerSymbol(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		symbol := r.URL.Query().Get("symbol")
		_ = json.NewEncoder(w).Encode(openInterestResp{Symbol: symbol, OpenInterest: "12345.6", Time: 1000})
	}))
	defer srv.Close()

	f := NewOIFeed([]string{"btcusdt", "ethusdt"}, slog.New(slog.DiscardHandler))
	f.restURL = srv.URL
	f.msgs = make(chan conn.RawMsg, 8)

	if err := f.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case m := <-f.msgs:
			oi := m.Env.Data.(norm.OI)
			if oi.OpenInterest != "12345.6" {
				t.Errorf("openInterest = %q, want 12345.6", oi.OpenInterest)
			}
			seen[m.Channel.Symbol] = true
		default:
			t.Fatal("expected a message")
		}
	}
	if !seen["btcusdt"] || !seen["ethusdt"] {
		t.Fatalf("seen = %v, want both symbols", seen)
	}
}

func TestOIFeed_PollOnce_ContinuesPastOneSymbolFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("symbol") == "BADUSDT" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(openInterestResp{Symbol: "BTCUSDT", OpenInterest: "1", Time: 1})
	}))
	defer srv.Close()

	f := NewOIFeed([]string{"badusdt", "btcusdt"}, slog.New(slog.DiscardHandler))
	f.restURL = srv.URL
	f.msgs = make(chan conn.RawMsg, 8)

	err := f.pollOnce(context.Background()) // expect a non-nil error (one symbol failed)...
	if err == nil {
		t.Fatal("expected an error from the failing symbol")
	}
	// ...but the other symbol should still have been polled.
	select {
	case m := <-f.msgs:
		if m.Channel.Symbol != "btcusdt" {
			t.Errorf("got symbol %q, want btcusdt", m.Channel.Symbol)
		}
	default:
		t.Fatal("expected btcusdt to still be polled despite badusdt failing")
	}
}
