package okx

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
	f.handle([]byte(`{"arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","px":"1","sz":"1","side":"buy","ts":"1","tradeId":"1"}]}`))
	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.okx.btcusdt.trades" {
		t.Errorf("channel = %q", m.Channel.String())
	}
	if _, ok := m.Env.Data.(norm.Trade); !ok {
		t.Errorf("data type = %T", m.Env.Data)
	}
}

func TestWSFeed_Handle_Candle(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"arg":{"channel":"candle1H","instId":"BTC-USDT-SWAP"},"data":[["1","1","1","1","1","1","1"]]}`))
	m := recvChan(t, f.msgs)
	if m.Channel.String() != "md.okx.btcusdt.candles.1h" {
		t.Errorf("channel = %q", m.Channel.String())
	}
}

func TestWSFeed_Handle_FundingAndOI_SeparateChannels(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`{"arg":{"channel":"funding-rate","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","fundingRate":"0.0001","fundingTime":"1"}]}`))
	f.handle([]byte(`{"arg":{"channel":"open-interest","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","oi":"5000","ts":"1"}]}`))

	first := recvChan(t, f.msgs)
	second := recvChan(t, f.msgs)
	if first.Channel.Kind != norm.KindFunding || second.Channel.Kind != norm.KindOI {
		t.Fatalf("kinds = %q, %q", first.Channel.Kind, second.Channel.Kind)
	}
}

func TestWSFeed_Handle_IgnoresPong(t *testing.T) {
	f := newTestWSFeed(t)
	f.handle([]byte(`pong`))
	select {
	case m := <-f.msgs:
		t.Fatalf("expected no message, got %+v", m)
	default:
	}
}
