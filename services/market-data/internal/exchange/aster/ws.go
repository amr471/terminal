package aster

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

// WSFeed is the single multiplexed Aster connection: trades (@aggTrade) +
// candles (@kline, all timeframes) + funding (@markPrice) + book
// (@depth20@100ms, full snapshots), across every configured symbol. Like
// binance.WSFeed the server sends control-frame pings that gorilla answers
// automatically, so there's no client ping loop; unlike binance the book is
// multiplexed here (partial-depth is snapshot-based — package doc).
type WSFeed struct {
	symbols []string
	wsURL   string
	log     *slog.Logger

	conn *wsutil.Conn
	msgs chan conn.RawMsg
	seq  atomic.Uint64
}

var _ conn.Feed = (*WSFeed)(nil)

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "aster.ws")}
}

func (f *WSFeed) Name() string                    { return "aster.ws" }
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
		return fmt.Errorf("aster.ws: subscribe: %w", err)
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
		return // subscribe ack / error frames have no "e"
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

// Resync resubscribes. The book is snapshot-based (partial depth), so the next
// depth message is a fresh full top-N — nothing gapped to repair.
func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	if err := f.conn.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": subscribeParams(f.symbols), "id": 2,
	}); err != nil {
		return fmt.Errorf("aster.ws: resync resubscribe: %w", err)
	}
	return nil
}

func (f *WSFeed) Close() error {
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
