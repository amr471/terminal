package binance

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange/wsutil"
	"github.com/terminal/market-data/internal/norm"
)

// WSFeed is trades + candles (all timeframes) + funding, multiplexed on one
// connection across every configured symbol (exchange-websockets skill: "one
// conn.Feed = one upstream connection"; Binance's combined-stream SUBSCRIBE
// method is exactly built for this). Seq is this Feed's own monotonic
// per-message counter — Manager.checkSeq only needs "did I lose a message,"
// not exchange-level book continuity (that's BookFeed's job, which needs its
// own per-symbol Feed so the Manager's single lastSeq stays meaningful — see
// package doc).
type WSFeed struct {
	symbols []string
	wsURL   string // overridable in tests
	log     *slog.Logger

	conn *wsutil.Conn
	msgs chan conn.RawMsg
	seq  atomic.Uint64
}

var _ conn.Feed = (*WSFeed)(nil)

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "binance.ws")}
}

func (f *WSFeed) Name() string { return "binance.ws" }

// ExpectedInterval: aggTrade/markPrice tick continuously on any actively
// traded symbol; 30s is a generous margin for a quiet moment without
// false-flagging staleness (§5.2).
func (f *WSFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *WSFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	if err := c.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": subscribeParams(f.symbols), "id": 1,
	}); err != nil {
		_ = c.Close()
		return fmt.Errorf("binance.ws: subscribe: %w", err)
	}
	f.conn = c
	f.msgs = make(chan conn.RawMsg, 256)
	go f.readLoop()
	return nil
}

func (f *WSFeed) readLoop() {
	defer close(f.msgs)
	for {
		raw, err := f.conn.ReadMessage()
		if err != nil {
			f.log.Warn("read error; feed will reconnect", "err", err)
			return
		}
		f.handle(raw)
	}
}

func (f *WSFeed) handle(raw []byte) {
	event, err := classify(raw)
	if err != nil {
		return // subscription ack / error frames have no "e"; not a decode failure worth logging
	}
	switch event {
	case "aggTrade":
		symbol, ts, trade, err := decodeAggTrade(raw)
		if err != nil {
			f.log.Warn("decode aggTrade failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindTrades, "", norm.TypeTrade, ts, trade)
	case "kline":
		symbol, ts, candle, err := decodeKline(raw)
		if err != nil {
			f.log.Warn("decode kline failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindCandles, candle.TF, norm.TypeCandle, ts, candle)
	case "markPriceUpdate":
		symbol, ts, funding, err := decodeMarkPrice(raw)
		if err != nil {
			f.log.Warn("decode markPrice failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindFunding, "", norm.TypeFunding, ts, funding)
	case "depthUpdate":
		symbol, ts, book, err := decodePartialDepth(raw)
		if err != nil {
			f.log.Warn("decode partial depth failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindBook, "", norm.TypeBook, ts, book)
	}
}

func (f *WSFeed) emit(symbol, kind, tf string, typ norm.MessageType, ts int64, data any) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: kind, TF: tf}
	env := norm.Envelope{
		V: 1, Type: typ, Src: exchangeName, Sym: symbol,
		TS: ts, RTS: time.Now().UnixMilli(), Seq: f.seq.Add(1), Data: data,
	}
	select {
	case f.msgs <- conn.RawMsg{Channel: ch, Env: env}:
	default:
		f.log.Warn("dropped message; consumer too slow", "channel", ch.String())
	}
}

func (f *WSFeed) Messages() <-chan conn.RawMsg { return f.msgs }

// Resync just resubscribes — none of this Feed's three channels carry
// exchange-level sequence state to repair (that's BookFeed's job); a
// resubscribe is the correct, cheap response if Manager's generic seq-gap
// check ever fires here (e.g. after a dropped-message backpressure event).
func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	if err := f.conn.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": subscribeParams(f.symbols), "id": 2,
	}); err != nil {
		return fmt.Errorf("binance.ws: resync resubscribe: %w", err)
	}
	return nil
}

func (f *WSFeed) Close() error {
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
