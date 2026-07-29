package okx

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

// WSFeed is trades + candles (all timeframes) + funding-rate + open-interest,
// multiplexed on one connection across every configured symbol (package doc:
// OKX exposes OI over websocket, so — like Bybit, unlike Binance — no REST
// poller is needed).
type WSFeed struct {
	symbols []string
	wsURL   string
	log     *slog.Logger

	conn   *wsutil.Conn
	msgs   chan conn.RawMsg
	seq    atomic.Uint64
	cancel context.CancelFunc
}

var _ conn.Feed = (*WSFeed)(nil)

// pingInterval: OKX's rule (exchange-websockets skill) — client sends the
// literal text "ping" every <30s. 20s keeps a comfortable margin.
const pingInterval = 20 * time.Second

// subscribePaceInterval spaces batched SUBSCRIBE writes to stay under OKX's
// documented 3-requests/second subscribe rate limit (verified 2026-07-17,
// see adapter.go's Limits() doc comment) with a comfortable margin. A full
// 200-symbol shard is ~25 batches at maxSubscribeBytes, so this adds a few
// seconds to initial connect — a one-time cost, not a steady-state one.
const subscribePaceInterval = 400 * time.Millisecond

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "okx.ws")}
}

func (f *WSFeed) Name() string                    { return "okx.ws" }
func (f *WSFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *WSFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	// Start reading and answering pings *before* subscribing: a full
	// 200-symbol shard's subscribe now takes several seconds across many
	// batches (subscribeAll below), and OKX starts acking/pushing data for
	// each batch as soon as it's sent. Nothing draining the connection
	// during that window would let acks/data pile up unread for the whole
	// subscribe duration instead of the usual sub-second window.
	f.conn = c
	// 1024, not the 256 other single-shard-multiplexed venues default to:
	// OKX puts a full 200-symbol shard on one connection (Limits().
	// MaxStreamsPerConn is uncapped — see adapter.go), and real-load logs
	// (2026-07-18) showed persistent "dropped message; consumer too slow"
	// here — 256 was undersized for trades+funding+OI+books5+6 candle
	// streams x 200 symbols. Same fix hyperliquid/bingx already got
	// 2026-07-17 for the same reason.
	f.msgs = make(chan conn.RawMsg, 1024)
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.readLoop(cancel)
	go f.pingLoop(loopCtx)
	if err := f.subscribeAll(ctx, c, subscribeArgsFor(f.symbols)); err != nil {
		_ = c.Close()
		return err
	}
	return nil
}

// subscribeAll sends args across as many SUBSCRIBE messages as
// subscribeBatches decides are needed to stay under OKX's per-message size
// limit, paced under its per-second rate limit. ctx-aware so a shutdown
// mid-subscribe doesn't block on the pacing sleep.
func (f *WSFeed) subscribeAll(ctx context.Context, c *wsutil.Conn, args []subscribeArg) error {
	batches := subscribeBatches(args)
	for i, batch := range batches {
		if err := c.WriteJSON(map[string]any{"op": "subscribe", "args": batch}); err != nil {
			return fmt.Errorf("okx.ws: subscribe batch %d/%d: %w", i+1, len(batches), err)
		}
		if i < len(batches)-1 {
			select {
			case <-time.After(subscribePaceInterval):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

func (f *WSFeed) readLoop(stop context.CancelFunc) {
	defer close(f.msgs)
	defer stop()
	for {
		raw, err := f.conn.ReadMessage()
		if err != nil {
			f.log.Warn("read error; feed will reconnect", "err", err)
			return
		}
		f.handle(raw)
	}
}

func (f *WSFeed) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := f.conn.WriteText("ping"); err != nil {
				f.log.Warn("ping failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *WSFeed) handle(raw []byte) {
	channel, instID, _, env, ok, err := classify(raw)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // pong / subscribe ack / error frame
	}
	switch {
	case channel == "trades":
		trades, err := decodeTrades(env)
		if err != nil {
			f.log.Warn("decode trades failed", "err", err)
			return
		}
		for _, t := range trades {
			f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
		}
	case channel == "funding-rate":
		symbol, ts, funding, err := decodeFunding(env)
		if err != nil {
			f.log.Warn("decode funding-rate failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindFunding, "", norm.TypeFunding, ts, funding)
	case channel == "open-interest":
		symbol, ts, oi, err := decodeOI(env)
		if err != nil {
			f.log.Warn("decode open-interest failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindOI, "", norm.TypeOI, ts, oi)
	case channel == "books5":
		symbol, ts, book, err := decodeBook5(instID, env)
		if err != nil {
			f.log.Warn("decode books5 failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindBook, "", norm.TypeBook, ts, book)
	case tfForChannel[channel] != "":
		symbol, tf, klines, err := decodeCandles(channel, instID, env)
		if err != nil {
			f.log.Warn("decode candles failed", "err", err)
			return
		}
		for _, k := range klines {
			f.emit(symbol, norm.KindCandles, tf, norm.TypeCandle, k.TS, k.Candle)
		}
	}
}

func (f *WSFeed) emit(symbol, kind, tf string, typ norm.MessageType, ts int64, data any) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: kind, TF: tf}
	// Seq only assigned on actual enqueue — see bybit/ws.go's WSFeed.emit
	// comment for the full reasoning (same fix, applied repo-wide, 2026-07-19,
	// same bug class that caused today's "dropped message"/"sequence
	// anomaly" pairs on this venue too).
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

func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	return f.subscribeAll(ctx, f.conn, subscribeArgsFor(f.symbols))
}

func (f *WSFeed) Close() error {
	if f.cancel != nil {
		f.cancel()
	}
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
