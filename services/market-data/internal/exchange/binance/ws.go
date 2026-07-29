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
	return &WSFeed{symbols: symbols, wsURL: wsMarketBase, log: log.With("feed", "binance.ws")}
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
	f.conn = c
	// Root-caused 2026-07-22: sending all of WSFeed's streams (~8/symbol, so
	// ~832 params for a ~100-symbol shard) in ONE SUBSCRIBE frame is rejected
	// by Binance's gateway with `1008 (policy violation): Invalid request`,
	// even though the total is well under the 1024 per-connection cap — the
	// 1024 limit is cumulative across frames, not a per-frame size. The
	// DepthFeed's single 96-param frame on the same server connects fine, so
	// the oversized frame is the only differing variable. Fix: subscribe in
	// small paced batches (see subscribeChunked / maxParamsPerSubscribe).
	if err := f.subscribeChunked(1); err != nil {
		_ = c.Close()
		f.conn = nil
		return fmt.Errorf("binance.ws: subscribe: %w", err)
	}
	f.msgs = make(chan conn.RawMsg, 256)
	go f.readLoop()
	return nil
}

// subscribeSpacing paces SUBSCRIBE frames under Binance's documented limit of
// 10 incoming messages/sec per connection; 120ms caps us at ~8/sec with margin.
const subscribeSpacing = 120 * time.Millisecond

// subscribeChunked sends marketSubscribeParams as several small SUBSCRIBE
// frames (each ≤ maxParamsPerSubscribe) instead of one oversized frame Binance
// rejects with 1008. Frames are paced by subscribeSpacing to respect the
// 10-msg/sec incoming limit. idBase seeds the per-frame id (1 for Connect, a
// higher base for Resync) so acks stay distinguishable in a capture.
func (f *WSFeed) subscribeChunked(idBase int) error {
	params := marketSubscribeParams(f.symbols)
	batches := chunkParams(params, maxParamsPerSubscribe)
	f.log.Info("subscribing", "symbols", len(f.symbols), "params", len(params), "batches", len(batches))
	for i, batch := range batches {
		if i > 0 {
			time.Sleep(subscribeSpacing)
		}
		if err := f.conn.WriteJSON(map[string]any{
			"method": "SUBSCRIBE", "params": batch, "id": idBase + i,
		}); err != nil {
			return err
		}
	}
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
	}
}

func (f *WSFeed) emit(symbol, kind, tf string, typ norm.MessageType, ts int64, data any) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: kind, TF: tf}
	// Seq is only assigned once we know the message will actually enqueue —
	// real bug found 2026-07-19: assigning it unconditionally before this
	// check meant a backpressure drop still consumed a sequence number, so
	// Manager.checkSeq (internal/conn/manager.go) saw a gap and misdiagnosed
	// an ordinary drop as a real "sequence anomaly," triggering a Resync()
	// that resubscribes every symbol on the shard — adding SUBSCRIBE traffic
	// on top of an already-overloaded connection and making the burst worse.
	// Safe without a lock: emit() only ever runs on this feed's single
	// readLoop goroutine (sole producer of f.msgs), so checking capacity
	// then sending can't race with another writer.
	if len(f.msgs) >= cap(f.msgs) {
		f.log.Warn("dropped message; consumer too slow", "channel", ch.String())
		return
	}
	f.msgs <- conn.RawMsg{Channel: ch, Env: norm.Envelope{
		V: 1, Type: typ, Src: exchangeName, Sym: symbol,
		TS: ts, RTS: time.Now().UnixMilli(), Seq: f.seq.Add(1), Data: data,
	}}
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
	// Same chunked/paced path as Connect — a single full-shard SUBSCRIBE here
	// would hit the same 1008 rejection (and, per the emit() note, a Resync
	// storm on an overloaded connection is exactly what we must avoid). id base
	// 1000 keeps resync acks distinguishable from Connect's in a capture.
	if err := f.subscribeChunked(1000); err != nil {
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
