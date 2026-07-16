package kucoin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange/wsutil"
	"github.com/terminal/market-data/internal/norm"
)

// WSFeed is the single multiplexed KuCoin Futures connection: execution
// (trades) + level2Depth50 (book snapshots) + limitCandle (all timeframes) +
// contract/instrument (funding), across every configured symbol. Book and
// candles are multiplexed here for the same reasons as HyperLiquid (snapshot
// book, no per-symbol seq); see package doc for the bullet-handshake connect.
type WSFeed struct {
	symbols []string
	baseURL string
	http    *http.Client
	log     *slog.Logger

	conn     *wsutil.Conn
	msgs     chan conn.RawMsg
	seq      atomic.Uint64
	pingID   atomic.Int64
	candles  *candleTracker
	pingival time.Duration
	cancel   context.CancelFunc
}

var _ conn.Feed = (*WSFeed)(nil)

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{
		symbols: symbols,
		baseURL: restBase,
		http:    &http.Client{Timeout: 10 * time.Second},
		log:     log.With("feed", "kucoin.ws"),
	}
}

func (f *WSFeed) Name() string                    { return "kucoin.ws" }
func (f *WSFeed) ExpectedInterval() time.Duration { return 30 * time.Second }

func (f *WSFeed) Connect(ctx context.Context) error {
	// Step 1: bullet handshake (REST) — token + endpoint + ping cadence.
	b, err := fetchBullet(ctx, f.http, f.baseURL)
	if err != nil {
		return err
	}
	// Step 2: dial the returned endpoint with token + connectId.
	connectID := strconv.FormatInt(time.Now().UnixNano(), 10)
	c, err := wsutil.Dial(ctx, b.dialURL(connectID))
	if err != nil {
		return err
	}
	if err := f.subscribe(c); err != nil {
		_ = c.Close()
		return err
	}
	f.conn = c
	f.pingival = b.pingInterval
	f.msgs = make(chan conn.RawMsg, 256)
	f.candles = newCandleTracker()
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.readLoop(cancel)
	go f.pingLoop(loopCtx)
	return nil
}

// subscribe sends one KuCoin subscribe frame per channel, each carrying every
// configured symbol comma-joined in the topic.
func (f *WSFeed) subscribe(c *wsutil.Conn) error {
	for _, topic := range topics(f.symbols) {
		frame := map[string]any{
			"id":       strconv.FormatInt(f.pingID.Add(1), 10),
			"type":     "subscribe",
			"topic":    topic,
			"response": true,
		}
		if err := c.WriteJSON(frame); err != nil {
			return fmt.Errorf("kucoin.ws: subscribe %s: %w", topic, err)
		}
	}
	return nil
}

// topics builds the multiplexed topic strings. execution/level2Depth50/
// instrument take a comma-joined symbol list; limitCandle keys each symbol to
// a granularity, so it lists every symbol_granularity pair.
func topics(symbols []string) []string {
	wires := make([]string, 0, len(symbols))
	for _, s := range symbols {
		if w, ok := wireSymbol(s); ok {
			wires = append(wires, w)
		}
	}
	if len(wires) == 0 {
		return nil
	}
	joined := strings.Join(wires, ",")
	out := []string{
		"/contractMarket/execution:" + joined,
		"/contractMarket/level2Depth50:" + joined,
		"/contract/instrument:" + joined,
	}
	candlePairs := make([]string, 0, len(wires)*len(timeframes))
	for _, w := range wires {
		for _, tf := range timeframes {
			candlePairs = append(candlePairs, w+"_"+granularityFor[tf])
		}
	}
	out = append(out, "/contractMarket/limitCandle:"+strings.Join(candlePairs, ","))
	return out
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

// pingLoop sends KuCoin's {"id","type":"ping"} on the cadence the bullet
// handshake returned (default 18s); the server drops the connection if a ping
// isn't seen within pingTimeout.
func (f *WSFeed) pingLoop(ctx context.Context) {
	interval := f.pingival
	if interval <= 0 {
		interval = 18 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			frame := map[string]string{"id": strconv.FormatInt(f.pingID.Add(1), 10), "type": "ping"}
			if err := f.conn.WriteJSON(frame); err != nil {
				f.log.Warn("ping failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *WSFeed) handle(raw []byte) {
	path, suffix, subject, data, ok, err := classify(raw)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // welcome / ack / pong / error
	}
	switch path {
	case "/contractMarket/execution":
		t, err := decodeTrade(data)
		if err != nil {
			f.log.Warn("decode execution failed", "err", err)
			return
		}
		f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
	case "/contractMarket/level2Depth50":
		b, err := decodeBook(suffix, data)
		if err != nil {
			f.log.Warn("decode level2Depth50 failed", "err", err)
			return
		}
		f.emit(b.Symbol, norm.KindBook, "", norm.TypeBook, b.TS, b.Book)
	case "/contractMarket/limitCandle":
		c, err := decodeCandle(suffix, data)
		if err != nil {
			f.log.Warn("decode limitCandle failed", "err", err)
			return
		}
		finalized, hasFinal, live := f.candles.observe(c)
		if hasFinal {
			f.emit(finalized.Symbol, norm.KindCandles, finalized.Candle.TF, norm.TypeCandle, finalized.TS, finalized.Candle)
		}
		f.emit(live.Symbol, norm.KindCandles, live.Candle.TF, norm.TypeCandle, live.TS, live.Candle)
	case "/contract/instrument":
		if subject != "funding.rate" {
			return // "mark.index.price" and others: no norm kind for them here
		}
		symbol, ts, funding, err := decodeFunding(suffix, data)
		if err != nil {
			f.log.Warn("decode funding.rate failed", "err", err)
			return
		}
		f.emit(symbol, norm.KindFunding, "", norm.TypeFunding, ts, funding)
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

// Resync re-sends the subscriptions. Book is snapshot-only (level2Depth50), so
// there is no gapped state to repair — same stance as the other multiplexed
// WSFeeds.
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
