package hyperliquid

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

// WSFeed is the single multiplexed HyperLiquid connection: trades + candles
// (all timeframes) + l2Book (full snapshots) + activeAssetCtx (funding+OI),
// across every configured symbol. See package doc for why the book is
// multiplexed here rather than split into per-symbol feeds like the CEX
// venues.
type WSFeed struct {
	symbols []string
	wsURL   string
	log     *slog.Logger

	conn    *wsutil.Conn
	msgs    chan conn.RawMsg
	seq     atomic.Uint64
	candles *candleTracker
	cancel  context.CancelFunc
}

var _ conn.Feed = (*WSFeed)(nil)

// pingInterval: HL closes an idle connection after ~60s; a client-sent
// {"method":"ping"} every 30s keeps it open with margin (exchange-websockets
// skill: VERIFY the idle window against live docs).
const pingInterval = 30 * time.Second

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "hyperliquid.ws")}
}

func (f *WSFeed) Name() string                    { return "hyperliquid.ws" }
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
	// funding+oi across every symbol on one connection, and real-load logs
	// (2026-07-17) showed persistent "dropped message; consumer too slow"
	// here — 256 was undersized for the burst size at a real symbol count.
	f.msgs = make(chan conn.RawMsg, 1024)
	f.candles = newCandleTracker()
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.readLoop(cancel)
	go f.pingLoop(loopCtx)
	return nil
}

// subscribe sends one {"method":"subscribe",...} message per subscription —
// HL takes them individually, not as a batched arg list.
func (f *WSFeed) subscribe(c *wsutil.Conn) error {
	for _, sub := range subscriptions(f.symbols) {
		if err := c.WriteJSON(map[string]any{"method": "subscribe", "subscription": sub}); err != nil {
			return fmt.Errorf("hyperliquid.ws: subscribe: %w", err)
		}
	}
	return nil
}

// subscriptions builds the per-coin subscription objects: trades, l2Book,
// activeAssetCtx, and one candle sub per timeframe. Skips symbols that don't
// map to a coin (non-USDT, coinFor ok=false).
func subscriptions(symbols []string) []map[string]any {
	var subs []map[string]any
	for _, sym := range symbols {
		coin, ok := coinFor(sym)
		if !ok {
			continue
		}
		subs = append(subs,
			map[string]any{"type": "trades", "coin": coin},
			map[string]any{"type": "l2Book", "coin": coin},
			map[string]any{"type": "activeAssetCtx", "coin": coin},
		)
		for _, tf := range timeframes {
			subs = append(subs, map[string]any{"type": "candle", "coin": coin, "interval": tf})
		}
	}
	return subs
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
			if err := f.conn.WriteJSON(map[string]string{"method": "ping"}); err != nil {
				f.log.Warn("ping failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *WSFeed) handle(raw []byte) {
	channel, data, ok, err := classify(raw)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // subscriptionResponse / pong / error
	}
	switch channel {
	case "trades":
		trades, err := decodeTrades(data)
		if err != nil {
			f.log.Warn("decode trades failed", "err", err)
			return
		}
		for _, t := range trades {
			f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
		}
	case "l2Book":
		b, err := decodeBook(data)
		if err != nil {
			f.log.Warn("decode l2Book failed", "err", err)
			return
		}
		f.emit(b.Symbol, norm.KindBook, "", norm.TypeBook, b.TS, b.Book)
	case "candle":
		c, err := decodeCandle(data)
		if err != nil {
			f.log.Warn("decode candle failed", "err", err)
			return
		}
		finalized, hasFinal, live := f.candles.observe(c)
		if hasFinal {
			f.emit(finalized.Symbol, norm.KindCandles, finalized.Candle.TF, norm.TypeCandle, finalized.TS, finalized.Candle)
		}
		f.emit(live.Symbol, norm.KindCandles, live.Candle.TF, norm.TypeCandle, live.TS, live.Candle)
	case "activeAssetCtx":
		c, err := decodeAssetCtx(data)
		if err != nil {
			f.log.Warn("decode activeAssetCtx failed", "err", err)
			return
		}
		ts := time.Now().UnixMilli() // HL sends no ctx event time (package doc)
		if c.Funding != nil {
			f.emit(c.Symbol, norm.KindFunding, "", norm.TypeFunding, ts, *c.Funding)
		}
		if c.OI != nil {
			f.emit(c.Symbol, norm.KindOI, "", norm.TypeOI, ts, *c.OI)
		}
	}
}

func (f *WSFeed) emit(symbol, kind, tf string, typ norm.MessageType, ts int64, data any) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: kind, TF: tf}
	// Seq only assigned on actual enqueue — see binance/ws.go's WSFeed.emit
	// comment for the full reasoning (same fix, applied repo-wide, 2026-07-19).
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

// Resync re-sends the subscriptions. HL's book is snapshot-only (the next
// l2Book message is a fresh full book), so there is no gapped state to
// repair — same stance as bybit/okx WSFeed.Resync.
func (f *WSFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	return f.subscribe(f.conn)
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
