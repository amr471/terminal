package bingx

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange/wsutil"
	"github.com/terminal/market-data/internal/norm"
)

// WSFeed is the single multiplexed BingX connection: trades + candles (all
// timeframes) + book (partial-depth snapshot), across every configured
// symbol. Every server frame is gzip-compressed; the read loop gunzips first
// and answers the "Ping" heartbeat with "Pong".
type WSFeed struct {
	symbols []string
	wsURL   string
	log     *slog.Logger

	conn    *wsutil.Conn
	msgs    chan conn.RawMsg
	seq     atomic.Uint64
	subID   atomic.Int64
	candles *candleTracker
}

var _ conn.Feed = (*WSFeed)(nil)

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "bingx.ws")}
}

func (f *WSFeed) Name() string                    { return "bingx.ws" }
func (f *WSFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *WSFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	if err := f.subscribe(c); err != nil {
		_ = c.Close()
		return err
	}
	f.conn = c
	// 1024, not the 256 other venues default to: this feed multiplexes
	// book+trades across every symbol on one connection, and real-load logs
	// (2026-07-17) showed persistent "dropped message; consumer too slow"
	// here — 256 was undersized for the burst size at a real symbol count.
	f.msgs = make(chan conn.RawMsg, 1024)
	f.candles = newCandleTracker()
	// No client ping loop: BingX is a reactive "Ping"->"Pong" heartbeat handled
	// inside readLoop, so there's no second goroutine to cancel. Close() drops
	// the connection, which unblocks ReadMessage and ends readLoop.
	go f.readLoop()
	return nil
}

// subscribe sends one {"id","reqType":"sub","dataType":...} frame per topic.
func (f *WSFeed) subscribe(c *wsutil.Conn) error {
	for _, dt := range dataTypes(f.symbols) {
		frame := map[string]any{
			"id":       strconv.FormatInt(f.subID.Add(1), 10),
			"reqType":  "sub",
			"dataType": dt,
		}
		if err := c.WriteJSON(frame); err != nil {
			return fmt.Errorf("bingx.ws: subscribe %s: %w", dt, err)
		}
	}
	return nil
}

// dataTypes builds the per-symbol topic list: @trade, @kline_<interval> for
// each tf, and @depth<level>@<interval>. Skips symbols that don't map.
func dataTypes(symbols []string) []string {
	var out []string
	for _, sym := range symbols {
		wire, ok := wireSymbol(sym)
		if !ok {
			continue
		}
		out = append(out, wire+"@trade", fmt.Sprintf("%s@depth%d@%s", wire, bookLevel, bookInterval))
		for _, tf := range timeframes {
			out = append(out, wire+"@kline_"+klineIntervalFor[tf])
		}
	}
	return out
}

func (f *WSFeed) readLoop() {
	defer close(f.msgs)
	for {
		raw, err := f.conn.ReadMessage()
		if err != nil {
			f.log.Warn("read error; feed will reconnect", "err", err)
			return
		}
		dec, err := decompress(raw)
		if err != nil {
			f.log.Warn("decompress failed", "err", err)
			continue
		}
		// Heartbeat: server sends "Ping", we must reply "Pong" (package doc).
		if string(dec) == "Ping" {
			if err := f.conn.WriteText("Pong"); err != nil {
				f.log.Warn("pong failed", "err", err)
			}
			continue
		}
		f.handle(dec)
	}
}

func (f *WSFeed) handle(dec []byte) {
	wire, kind, interval, data, ok, err := classify(dec)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // ack / unconsumed channel
	}
	switch kind {
	case "trade":
		trades, err := decodeTrades(wire, data)
		if err != nil {
			f.log.Warn("decode trades failed", "err", err)
			return
		}
		for _, t := range trades {
			f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
		}
	case "kline":
		c, err := decodeKline(wire, interval, data)
		if err != nil {
			f.log.Warn("decode kline failed", "err", err)
			return
		}
		finalized, hasFinal, live := f.candles.observe(c)
		if hasFinal {
			f.emit(finalized.Symbol, norm.KindCandles, finalized.Candle.TF, norm.TypeCandle, finalized.TS, finalized.Candle)
		}
		f.emit(live.Symbol, norm.KindCandles, live.Candle.TF, norm.TypeCandle, live.TS, live.Candle)
	case "depth":
		b, err := decodeDepth(wire, data)
		if err != nil {
			f.log.Warn("decode depth failed", "err", err)
			return
		}
		f.emit(b.Symbol, norm.KindBook, "", norm.TypeBook, b.TS, b.Book)
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

// Resync resubscribes. The book is a snapshot stream, so the next depth frame
// is a fresh full top-N — nothing gapped to repair.
func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	return f.subscribe(f.conn)
}

func (f *WSFeed) Close() error {
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
