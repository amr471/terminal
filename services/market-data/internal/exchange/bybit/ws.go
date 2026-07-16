package bybit

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

// WSFeed is trades + candles (all timeframes) + tickers (funding+OI in one
// channel), multiplexed on one connection across every configured symbol —
// see package doc for why this differs from Binance (no separate OI poller
// needed).
type WSFeed struct {
	symbols []string
	wsURL   string
	log     *slog.Logger

	conn   *wsutil.Conn
	msgs   chan conn.RawMsg
	seq    atomic.Uint64
	cancel context.CancelFunc

	// books tracks per-symbol orderbook sequence state. Only the readLoop
	// goroutine touches it (via handle), so no mutex is needed. Bybit's
	// orderbook is snapshot+delta with a per-symbol update id `u`; a gap
	// triggers a resubscribe of just that symbol's topic (Bybit replays a
	// fresh snapshot). Multiplexed here at P1.5c instead of a per-symbol feed.
	books map[string]*bookSeq
}

type bookSeq struct {
	lastU  uint64
	synced bool
}

var _ conn.Feed = (*WSFeed)(nil)

// pingInterval: Bybit v5's own rule (exchange-websockets skill) — client
// sends {"op":"ping"} every 20s or the connection is dropped.
const pingInterval = 20 * time.Second

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "bybit.ws")}
}

func (f *WSFeed) Name() string                    { return "bybit.ws" }
func (f *WSFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *WSFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	if err := c.WriteJSON(map[string]any{"op": "subscribe", "args": subscribeArgs(f.symbols)}); err != nil {
		_ = c.Close()
		return fmt.Errorf("bybit.ws: subscribe: %w", err)
	}
	f.conn = c
	f.msgs = make(chan conn.RawMsg, 256)
	f.books = make(map[string]*bookSeq)
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.readLoop(cancel)
	go f.pingLoop(loopCtx)
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
			if err := f.conn.WriteJSON(map[string]string{"op": "ping"}); err != nil {
				f.log.Warn("ping failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *WSFeed) handle(raw []byte) {
	kind, parts, env, ok, err := classify(raw)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // subscribe ack / pong frame, nothing to route
	}
	switch kind {
	case "publicTrade":
		trades, err := decodeTrades(env)
		if err != nil {
			f.log.Warn("decode trades failed", "err", err)
			return
		}
		for _, t := range trades {
			f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
		}
	case "kline":
		symbol, tf, klines, err := decodeKlines(parts, env)
		if err != nil {
			f.log.Warn("decode klines failed", "err", err)
			return
		}
		for _, k := range klines {
			f.emit(symbol, norm.KindCandles, tf, norm.TypeCandle, k.TS, k.Candle)
		}
	case "tickers":
		symbol, ts, funding, oi, err := decodeTicker(parts, env)
		if err != nil {
			f.log.Warn("decode tickers failed", "err", err)
			return
		}
		if funding != nil {
			f.emit(symbol, norm.KindFunding, "", norm.TypeFunding, ts, *funding)
		}
		if oi != nil {
			f.emit(symbol, norm.KindOI, "", norm.TypeOI, ts, *oi)
		}
	case "orderbook":
		msg, err := decodeOrderbook(env)
		if err != nil {
			f.log.Warn("decode orderbook failed", "err", err)
			return
		}
		f.onBook(env.Type, msg)
	}
}

// onBook applies Bybit's snapshot/delta orderbook per symbol and forwards it
// downstream (the store's localBook merges deltas). A per-symbol sequence gap
// resubscribes just that symbol's topic — Bybit replays a fresh snapshot.
// Runs only on the readLoop goroutine, so f.books needs no lock.
func (f *WSFeed) onBook(msgType string, msg orderbookMsg) {
	sym := norm.NormalizeSymbol(msg.Symbol)
	if msgType == "snapshot" {
		f.books[sym] = &bookSeq{lastU: msg.U, synced: true}
		f.emitBook(sym, msg, true)
		return
	}
	st := f.books[sym]
	if st == nil || !st.synced || msg.U != st.lastU+1 {
		got := uint64(0)
		if st != nil {
			got = st.lastU
		}
		f.log.Warn("orderbook sequence gap; resubscribing", "sym", sym, "want", got+1, "got", msg.U)
		f.books[sym] = &bookSeq{synced: false}
		f.resubscribeBook(sym)
		return
	}
	st.lastU = msg.U
	f.emitBook(sym, msg, false)
}

// resubscribeBook forces Bybit to replay a fresh snapshot for one symbol,
// without disturbing the other multiplexed topics on this connection.
func (f *WSFeed) resubscribeBook(sym string) {
	if f.conn == nil {
		return
	}
	topic := orderbookTopic(sym)
	_ = f.conn.WriteJSON(map[string]any{"op": "unsubscribe", "args": []string{topic}})
	if err := f.conn.WriteJSON(map[string]any{"op": "subscribe", "args": []string{topic}}); err != nil {
		f.log.Warn("orderbook resubscribe failed", "sym", sym, "err", err)
	}
}

func (f *WSFeed) emitBook(sym string, msg orderbookMsg, snapshot bool) {
	f.emit(sym, norm.KindBook, "", norm.TypeBook, time.Now().UnixMilli(),
		norm.Book{Bids: toDecLevels(msg.Bids), Asks: toDecLevels(msg.Asks), Snapshot: snapshot, BookSeq: msg.U})
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

// Resync resubscribes — same reasoning as binance.WSFeed.Resync: nothing on
// this connection carries exchange-level sequence state to repair.
func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	if err := f.conn.WriteJSON(map[string]any{"op": "subscribe", "args": subscribeArgs(f.symbols)}); err != nil {
		return fmt.Errorf("bybit.ws: resync resubscribe: %w", err)
	}
	return nil
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
