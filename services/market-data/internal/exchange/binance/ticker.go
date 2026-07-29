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

// TickerFeed is the all-market 24h ticker stream (`!ticker@arr`) — ONE stream
// carrying rolling 24h stats for every symbol Binance lists, pushed ~1/sec as
// a JSON array.
//
// Why this feed exists (P1.5e): `instrument_state.volume_24h` and `change_24h`
// used to be derived solely by summing our OWN recorded 1h candles, and a
// candle is only persisted once FINAL — so a freshly started process had no
// history and left both NULL for every symbol. The screener's `volume_24h > 0`
// filter can't match NULL, so nearly every coin (all of Binance included)
// silently vanished from the table, leaving a handful of rows with
// partial-window volumes. A venue's own 24h ticker is correct on the very
// first message, which fixes both the coin count and the numbers.
//
// It's a VENUE-WIDE singleton (exchange.VenueFeeder), not a per-shard feed:
// `!ticker@arr` already covers every symbol, so one connection serves the whole
// venue regardless of sharding — and it costs exactly 1 stream, so it doesn't
// eat into the per-connection budget that forced WSFeed's chunked subscribe.
// It also reports symbols outside our sharded subscription set, which is
// deliberate: they're real listed instruments and belong in the screener.
type TickerFeed struct {
	wsURL string // overridable in tests
	log   *slog.Logger

	conn *wsutil.Conn
	msgs chan conn.RawMsg
	seq  atomic.Uint64
	// frames/drops feed the diagnostics in handle()/emit(). Only ever touched on
	// the single readLoop goroutine (emit runs there too).
	frames uint64
	drops  uint64
}

var _ conn.Feed = (*TickerFeed)(nil)

func NewTickerFeed(log *slog.Logger) *TickerFeed {
	return &TickerFeed{wsURL: wsMarketBase, log: log.With("feed", "binance.ws.ticker")}
}

func (f *TickerFeed) Name() string { return "binance.ws.ticker" }

// ExpectedInterval: `!ticker@arr` pushes every 1000ms on a live market; 30s is
// the same generous staleness margin the other feeds in this package use.
func (f *TickerFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *TickerFeed) Connect(ctx context.Context) error {
	c, err := wsutil.Dial(ctx, f.wsURL)
	if err != nil {
		return err
	}
	f.conn = c
	// One param, so no chunking needed here (unlike WSFeed — see ws.go).
	if err := c.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": []string{allTickerStream}, "id": 1,
	}); err != nil {
		_ = c.Close()
		f.conn = nil
		return fmt.Errorf("binance.ws.ticker: subscribe: %w", err)
	}
	// Buffer is large relative to the other feeds on purpose: each frame fans
	// out to one message PER SYMBOL (Binance lists thousands of perps), so a
	// single read can enqueue thousands of messages at once.
	f.msgs = make(chan conn.RawMsg, 8192)
	go f.readLoop()
	return nil
}

func (f *TickerFeed) readLoop() {
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

func (f *TickerFeed) handle(raw []byte) {
	// `!ticker@arr` frames are a JSON ARRAY, so the usual classify() peek (which
	// reads the "e" discriminator off an object) doesn't apply — decodeAllTickers
	// returns ok=false for the subscribe ack and any other non-array frame.
	tickers, ok := decodeAllTickers(raw, f.log)
	if !ok {
		return
	}
	// Diagnostic (2026-07-26): on John's run the screener still showed zero
	// Binance rows even though this feed should cover every symbol, and the
	// generic feed logs can't distinguish "never connected" from "connected but
	// every message dropped downstream". Logging the first frame's symbol count
	// once (and then every 5 min) makes that unambiguous on the next live run
	// without flooding a 1/sec stream. Cheap, and removable once confirmed.
	f.frames++
	if f.frames == 1 || f.frames%300 == 0 {
		f.log.Info("all-market ticker frame", "symbols", len(tickers), "frames", f.frames,
			"queued", len(f.msgs), "capacity", cap(f.msgs))
	}
	for _, t := range tickers {
		f.emit(t.symbol, t.ts, t.ticker)
	}
}

func (f *TickerFeed) emit(symbol string, ts int64, tk norm.Ticker) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: norm.KindTicker}
	// Seq only assigned on actual enqueue — see WSFeed.emit (ws.go) for the
	// real bug that motivated this ordering.
	if len(f.msgs) >= cap(f.msgs) {
		// Rate-limited: one frame is thousands of symbols, so an unthrottled
		// warn here would itself become the bottleneck (and bury the log).
		f.drops++
		if f.drops == 1 || f.drops%10000 == 0 {
			f.log.Warn("dropped ticker; consumer too slow", "channel", ch.String(), "drops", f.drops)
		}
		return
	}
	f.msgs <- conn.RawMsg{Channel: ch, Env: norm.Envelope{
		V: 1, Type: norm.TypeTicker, Src: exchangeName, Sym: symbol,
		TS: ts, RTS: time.Now().UnixMilli(), Seq: f.seq.Add(1), Data: tk,
	}}
}

func (f *TickerFeed) Messages() <-chan conn.RawMsg { return f.msgs }

// Resync just resubscribes: every frame is a complete 24h snapshot for every
// symbol, so there's no gapped state to repair — same stance as the other
// feeds in this package.
func (f *TickerFeed) Resync(ctx context.Context) error {
	if f.conn == nil {
		return nil
	}
	if err := f.conn.WriteJSON(map[string]any{
		"method": "SUBSCRIBE", "params": []string{allTickerStream}, "id": 2,
	}); err != nil {
		return fmt.Errorf("binance.ws.ticker: resync resubscribe: %w", err)
	}
	return nil
}

func (f *TickerFeed) Close() error {
	if f.conn == nil {
		return nil
	}
	return f.conn.Close()
}
