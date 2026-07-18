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

// DepthFeed is the single multiplexed connection to Binance's /public route
// (partial-book-depth snapshot only), across every configured symbol. Split
// out of WSFeed at the 2026-07-17 routing migration — see package doc in
// binance.go for why depth can no longer share WSFeed's connection.
type DepthFeed struct {
	symbols []string
	wsURL   string // overridable in tests
	log     *slog.Logger

	conn *wsutil.Conn
	msgs chan conn.RawMsg
	seq  atomic.Uint64
}

var _ conn.Feed = (*DepthFeed)(nil)

func NewDepthFeed(symbols []string, log *slog.Logger) *DepthFeed {
	return &DepthFeed{symbols: symbols, wsURL: wsPublicBase, log: log.With("feed", "binance.ws.depth")}
}

func (f *DepthFeed) Name() string { return "binance.ws.depth" }

// ExpectedInterval: partial-depth snapshots push at a fixed 100ms cadence
// per subscribed symbol (bookDepth's @100ms suffix); 30s gives the same
// generous margin WSFeed uses for its own always-ticking streams.
func (f *DepthFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *DepthFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	if err := c.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": depthSubscribeParams(f.symbols), "id": 1,
	}); err != nil {
		_ = c.Close()
		return fmt.Errorf("binance.ws.depth: subscribe: %w", err)
	}
	f.conn = c
	f.msgs = make(chan conn.RawMsg, 256)
	go f.readLoop()
	return nil
}

func (f *DepthFeed) readLoop() {
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

func (f *DepthFeed) handle(raw []byte) {
	event, err := classify(raw)
	if err != nil {
		return // subscription ack / error frames have no "e"; not a decode failure worth logging
	}
	if event != "depthUpdate" {
		return
	}
	symbol, ts, book, err := decodePartialDepth(raw)
	if err != nil {
		f.log.Warn("decode partial depth failed", "err", err)
		return
	}
	f.emit(symbol, norm.KindBook, "", norm.TypeBook, ts, book)
}

func (f *DepthFeed) emit(symbol, kind, tf string, typ norm.MessageType, ts int64, data any) {
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

func (f *DepthFeed) Messages() <-chan conn.RawMsg { return f.msgs }

// Resync just resubscribes: each partial-depth message is already a full
// top-N snapshot (package doc on decodePartialDepth), so there's no gapped
// state to repair — same stance as WSFeed.Resync.
func (f *DepthFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	if err := f.conn.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": depthSubscribeParams(f.symbols), "id": 2,
	}); err != nil {
		return fmt.Errorf("binance.ws.depth: resync resubscribe: %w", err)
	}
	return nil
}

func (f *DepthFeed) Close() error {
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
