package mexc

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

// WSFeed is the single multiplexed MEXC Futures connection: trades (sub.deal)
// + candles (sub.kline, all timeframes) + funding (sub.funding.rate), across
// every configured symbol. Book/OI are scoped out (package doc).
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

// pingInterval: MEXC closes an idle connection after 1 minute; a ping every
// 15s (its 10–20s recommended window) keeps it open with margin.
const pingInterval = 15 * time.Second

func NewWSFeed(symbols []string, log *slog.Logger) *WSFeed {
	return &WSFeed{symbols: symbols, wsURL: wsBase, log: log.With("feed", "mexc.ws")}
}

func (f *WSFeed) Name() string                    { return "mexc.ws" }
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
	f.msgs = make(chan conn.RawMsg, 256)
	f.candles = newCandleTracker()
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.readLoop(cancel)
	go f.pingLoop(loopCtx)
	return nil
}

// subscribe sends one frame per (symbol,channel). "gzip":false requests plain
// JSON responses (no decompression). Each frame is a distinct MEXC command.
func (f *WSFeed) subscribe(c *wsutil.Conn) error {
	for _, sym := range f.symbols {
		wire, ok := wireSymbol(sym)
		if !ok {
			continue
		}
		frames := []map[string]any{
			{"method": "sub.deal", "param": map[string]any{"symbol": wire}, "gzip": false},
			{"method": "sub.funding.rate", "param": map[string]any{"symbol": wire}, "gzip": false},
		}
		for _, tf := range timeframes {
			frames = append(frames, map[string]any{
				"method": "sub.kline",
				"param":  map[string]any{"symbol": wire, "interval": intervalFor[tf]},
				"gzip":   false,
			})
		}
		for _, fr := range frames {
			if err := c.WriteJSON(fr); err != nil {
				return fmt.Errorf("mexc.ws: subscribe %v: %w", fr["method"], err)
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
			if err := f.conn.WriteJSON(map[string]string{"method": "ping"}); err != nil {
				f.log.Warn("ping failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *WSFeed) handle(raw []byte) {
	channel, symbol, data, ts, ok, err := classify(raw)
	if err != nil {
		f.log.Warn("classify failed", "err", err)
		return
	}
	if !ok {
		return // rs.* ack / pong / error
	}
	switch channel {
	case "push.deal":
		trades, err := decodeDeals(symbol, data)
		if err != nil {
			f.log.Warn("decode deal failed", "err", err)
			return
		}
		for _, t := range trades {
			f.emit(t.Symbol, norm.KindTrades, "", norm.TypeTrade, t.TS, t.Trade)
		}
	case "push.kline":
		c, err := decodeKline(symbol, data)
		if err != nil {
			f.log.Warn("decode kline failed", "err", err)
			return
		}
		finalized, hasFinal, live := f.candles.observe(c)
		if hasFinal {
			f.emit(finalized.Symbol, norm.KindCandles, finalized.Candle.TF, norm.TypeCandle, finalized.TS, finalized.Candle)
		}
		f.emit(live.Symbol, norm.KindCandles, live.Candle.TF, norm.TypeCandle, live.TS, live.Candle)
	case "push.funding.rate":
		sym, funding, err := decodeFunding(symbol, data)
		if err != nil {
			f.log.Warn("decode funding.rate failed", "err", err)
			return
		}
		f.emit(sym, norm.KindFunding, "", norm.TypeFunding, ts, funding)
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

// Resync resubscribes. None of these channels carry exchange-level book
// sequence state (book is scoped out), so a resubscribe is the whole repair.
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
