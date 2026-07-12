package pub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/health"
	"github.com/terminal/market-data/internal/norm"
)

func newTestRedis(t *testing.T) (*Redis, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedis(client), mr, client
}

func TestPublish_SendsEnvelopeOnMdChannel(t *testing.T) {
	r, _, client := newTestRedis(t)
	ctx := context.Background()

	sub := client.Subscribe(ctx, "md.binance.btcusdt.trades")
	defer func() { _ = sub.Close() }()
	if _, err := sub.Receive(ctx); err != nil { // wait for subscription
		t.Fatal(err)
	}

	msg := conn.RawMsg{
		Channel: norm.Channel{Exchange: "binance", Symbol: "btcusdt", Kind: norm.KindTrades},
		Env: norm.Envelope{
			V: 1, Type: norm.TypeTrade, Src: "binance", Sym: "btcusdt",
			TS: 1, RTS: 2, Seq: 1, Data: norm.Trade{Price: "64123.50", Qty: "1", Side: "buy"},
		},
	}
	if err := r.Publish(ctx, msg); err != nil {
		t.Fatal(err)
	}

	received, err := sub.ReceiveMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var env norm.Envelope
	if err := json.Unmarshal([]byte(received.Payload), &env); err != nil {
		t.Fatal(err)
	}
	if env.Seq != 1 || env.Type != norm.TypeTrade {
		t.Errorf("envelope corrupted: %+v", env)
	}
}

func TestAppendEvent_WritesCappedStream(t *testing.T) {
	r, mr, _ := newTestRedis(t)
	ctx := context.Background()

	env := norm.Envelope{V: 1, Type: norm.TypeLiq, Src: "binance", Sym: "btcusdt", TS: 1, RTS: 2, Seq: 7,
		Data: norm.Liq{Side: "long", Price: "64000", Qty: "3"}}
	if err := r.AppendEvent(ctx, "evt.liq", env); err != nil {
		t.Fatal(err)
	}
	entries, err := mr.Stream("evt.liq")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("stream length = %d, want 1", len(entries))
	}
}

func TestHeartbeat_WritesHealthKeyWithTTL(t *testing.T) {
	r, mr, _ := newTestRedis(t)
	reg := health.NewRegistry()
	reg.Set("binance.ws", health.StateLive)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Heartbeat(ctx, "market-data", reg, 10*time.Millisecond)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if mr.Exists("health:market-data") {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !mr.Exists("health:market-data") {
		t.Fatal("health key never written")
	}
	ttl := mr.TTL("health:market-data")
	if ttl <= 0 || ttl > 30*time.Millisecond {
		t.Errorf("TTL = %v, want (0, 3×interval]", ttl)
	}
	raw, err := mr.Get("health:market-data")
	if err != nil {
		t.Fatal(err)
	}
	var rep health.Report
	if err := json.Unmarshal([]byte(raw), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Status != health.StateLive || rep.Feeds["binance.ws"] != health.StateLive {
		t.Errorf("report wrong: %+v", rep)
	}
}
