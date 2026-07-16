package bybit

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

func TestWSFeed_Handle_Trade(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"topic":"publicTrade.BTCUSDT","ts":1,"data":[{"T":1,"s":"BTCUSDT","S":"Buy","v":"1","p":"1","i":"x"}]}`))
	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.bybit.btcusdt.trades" {
		t.Errorf("channel = %q", m.Channel.String())
	}
	if _, ok := m.Env.Data.(norm.Trade); !ok {
		t.Errorf("data type = %T", m.Env.Data)
	}
}

func TestWSFeed_Handle_Kline(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"topic":"kline.60.BTCUSDT","ts":1,"data":[{"start":1,"interval":"60","open":"1","high":"1","low":"1","close":"1","volume":"1","confirm":false}]}`))
	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.bybit.btcusdt.candles.1h" {
		t.Errorf("channel = %q", m.Channel.String())
	}
}

func TestWSFeed_Handle_Ticker_EmitsBothFundingAndOI(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"topic":"tickers.BTCUSDT","ts":1,"data":{"symbol":"BTCUSDT","fundingRate":"0.0001","openInterest":"5000"}}`))

	first := recvChan(t, f.msgs)
	second := recvChan(t, f.msgs)
	kinds := map[string]bool{first.Channel.Kind: true, second.Channel.Kind: true}
	if !kinds[norm.KindFunding] || !kinds[norm.KindOI] {
		t.Fatalf("expected both funding and oi channels, got %v", kinds)
	}
}

func TestWSFeed_Handle_IgnoresNonTopicFrame(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"op":"pong","success":true}`))
	select {
	case m := <-f.msgs:
		t.Fatalf("expected no message, got %+v", m)
	default:
	}
}
