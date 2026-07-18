package binance

import (
	"log/slog"
	"testing"

	"github.com/terminal/market-data/internal/conn"
)

func newTestDepthFeed(t *testing.T) *DepthFeed {
	t.Helper()
	f := NewDepthFeed([]string{"btcusdt"}, slog.New(slog.DiscardHandler))
	f.msgs = make(chan conn.RawMsg, 16)
	return f
}

func TestDepthFeed_Handle_RoutesDepthToBookChannel(t *testing.T) {
	f := newTestDepthFeed(t)
	f.handle([]byte(`{"e":"depthUpdate","E":1,"T":1,"s":"BTCUSDT","U":1,"u":5,"pu":0,"b":[["1","1"]],"a":[["2","1"]]}`))

	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.binance.btcusdt.book" {
		t.Errorf("channel = %q", m.Channel.String())
	}
}

func TestDepthFeed_Handle_IgnoresNonDepthEvents(t *testing.T) {
	f := newTestDepthFeed(t)
	// DepthFeed only ever receives depth frames on the /public route in
	// production, but handle() should still ignore anything else defensively.
	f.handle([]byte(`{"e":"aggTrade","E":1,"s":"BTCUSDT","p":"1","q":"1","m":false,"a":1}`))

	select {
	case m := <-f.msgs:
		t.Fatalf("expected no message for a non-depth event, got %+v", m)
	default:
	}
}

func TestDepthFeed_Handle_IgnoresNonEventFrames(t *testing.T) {
	f := newTestDepthFeed(t)
	f.handle([]byte(`{"result":null,"id":1}`)) // subscription ack

	select {
	case m := <-f.msgs:
		t.Fatalf("expected no message for a subscription ack, got %+v", m)
	default:
	}
}
