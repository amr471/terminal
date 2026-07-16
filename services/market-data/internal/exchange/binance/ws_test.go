package binance

import (
	"log/slog"
	"testing"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

func newTestWSFeed(t *testing.T) *WSFeed {
	t.Helper()
	f := NewWSFeed([]string{"btcusdt"}, slog.New(slog.DiscardHandler))
	f.msgs = make(chan conn.RawMsg, 16)
	return f
}

func recvChan(t *testing.T, msgs <-chan conn.RawMsg) conn.RawMsg {
	t.Helper()
	select {
	case m := <-msgs:
		return m
	default:
		t.Fatal("expected a message on the channel")
		return conn.RawMsg{}
	}
}

func TestWSFeed_Handle_RoutesTradeToTradesChannel(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"e":"aggTrade","E":1,"s":"BTCUSDT","p":"64123.50","q":"1","m":false,"a":1}`))

	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.binance.btcusdt.trades" {
		t.Errorf("channel = %q", m.Channel.String())
	}
	if _, ok := m.Env.Data.(norm.Trade); !ok {
		t.Errorf("data type = %T, want norm.Trade", m.Env.Data)
	}
}

func TestWSFeed_Handle_RoutesKlineToCandlesChannelWithTF(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"e":"kline","E":1,"s":"BTCUSDT","k":{"i":"5m","o":"1","h":"1","l":"1","c":"1","v":"1","x":true}}`))

	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.binance.btcusdt.candles.5m" {
		t.Errorf("channel = %q", m.Channel.String())
	}
}

func TestWSFeed_Handle_RoutesMarkPriceToFundingChannel(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"e":"markPriceUpdate","E":1,"s":"BTCUSDT","r":"0.0001","T":1}`))

	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.binance.btcusdt.funding" {
		t.Errorf("channel = %q", m.Channel.String())
	}
}

func TestWSFeed_Handle_IgnoresNonEventFrames(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"result":null,"id":1}`)) // subscription ack

	select {
	case m := <-f.msgs:
		t.Fatalf("expected no message for a subscription ack, got %+v", m)
	default:
	}
}

func TestWSFeed_Handle_SeqIsContiguousAcrossChannels(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"e":"aggTrade","E":1,"s":"BTCUSDT","p":"1","q":"1","m":false,"a":1}`))
	f.handle([]byte(`{"e":"markPriceUpdate","E":1,"s":"ETHUSDT","r":"0.0001"}`))

	first := recvChan(t, f.msgs)
	second := recvChan(t, f.msgs)
	if second.Env.Seq != first.Env.Seq+1 {
		t.Errorf("seq not contiguous across different symbols/channels on one feed: %d then %d",
			first.Env.Seq, second.Env.Seq)
	}
}
