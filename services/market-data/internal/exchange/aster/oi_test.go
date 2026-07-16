package aster

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestOIFeedPollsAndEmits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fapi/v1/openInterest" || r.URL.Query().Get("symbol") != "BTCUSDT" {
			t.Errorf("unexpected request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"symbol":"BTCUSDT","openInterest":"12345.6","time":1700000000000}`))
	}))
	defer srv.Close()

	f := &OIFeed{
		symbols:    []string{"btcusdt"},
		restURL:    srv.URL,
		interval:   time.Hour,
		httpClient: srv.Client(),
		log:        testLog(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	select {
	case msg := <-f.Messages():
		if msg.Channel.Exchange != "aster" || msg.Channel.Symbol != "btcusdt" || msg.Channel.Kind != "oi" {
			t.Fatalf("channel = %+v", msg.Channel)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no OI message emitted")
	}
	_ = f.Close()
}

func TestOIFeedConnectFailsFast(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	f := &OIFeed{symbols: []string{"btcusdt"}, restURL: srv.URL, interval: time.Hour, httpClient: srv.Client(), log: testLog()}
	if err := f.Connect(context.Background()); err == nil {
		t.Fatal("expected Connect to fail when initial poll 500s")
	}
}
