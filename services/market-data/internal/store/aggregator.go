package store

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

// Aggregator maintains instrument_state + the cache:ticker/cache:book Redis
// keys from live envelopes. Two responsibilities run on different cadences,
// deliberately not per-tick, so a busy trade stream never hammers Postgres:
//
//   - live fields (price, spread, funding rate, open interest) update
//     in-memory on every tick, cheap; a flush loop (flushInterval, default 2s)
//     periodically upserts the current snapshot to instrument_state.
//   - derived stats (change_1h/24h/7d, volume_24h, volatility_24h) need
//     historical candles, so a slower recompute loop (recomputeInterval,
//     default 30s) queries our own hypertables and updates the in-memory
//     state for the next flush to pick up.
//
// cache:ticker/cache:book write straight to Redis per-tick (cheap, and the
// gateway's first-paint snapshot endpoint wants them fresh, docs/gateway-ws.md).
type Aggregator struct {
	w     writer
	redis redis.UniversalClient
	clock conn.Clock
	log   *slog.Logger

	flushInterval     time.Duration
	recomputeInterval time.Duration

	mu     sync.Mutex
	states map[string]*InstrumentState
	books  map[string]*localBook
}

// NewAggregator wires production defaults (2s flush, 30s recompute).
func NewAggregator(w writer, redisClient redis.UniversalClient, log *slog.Logger) *Aggregator {
	return &Aggregator{
		w:                 w,
		redis:             redisClient,
		clock:             conn.RealClock{},
		log:               log,
		flushInterval:     2 * time.Second,
		recomputeInterval: 30 * time.Second,
		states:            map[string]*InstrumentState{},
		books:             map[string]*localBook{},
	}
}

// WithClock swaps the clock (tests). Returns a for chaining.
func (a *Aggregator) WithClock(c conn.Clock) *Aggregator { a.clock = c; return a }

// WithIntervals overrides the flush/recompute cadence (tests). Returns a for
// chaining.
func (a *Aggregator) WithIntervals(flush, recompute time.Duration) *Aggregator {
	a.flushInterval, a.recomputeInterval = flush, recompute
	return a
}

func (a *Aggregator) stateFor(exchange, symbol string) *InstrumentState {
	k := key(exchange, symbol)
	s, ok := a.states[k]
	if !ok {
		s = &InstrumentState{Exchange: exchange, Symbol: symbol, AssetClass: "crypto"}
		a.states[k] = s
	}
	return s
}

func (a *Aggregator) bookFor(exchange, symbol string) *localBook {
	k := key(exchange, symbol)
	b, ok := a.books[k]
	if !ok {
		b = newLocalBook()
		a.books[k] = b
	}
	return b
}

// OnTrade updates the live price and refreshes cache:ticker (TTL 10s —
// architecture.md §4.1; if trades stop, the key naturally expires, a
// staleness signal for anything reading it).
func (a *Aggregator) OnTrade(ctx context.Context, exchange, symbol string, env norm.Envelope, trade norm.Trade) {
	price, err := decimal.NewFromString(trade.Price)
	if err != nil {
		a.log.Warn("store: malformed trade price", "exchange", exchange, "sym", symbol, "price", trade.Price)
		return
	}
	a.mu.Lock()
	s := a.stateFor(exchange, symbol)
	s.Price = &price
	s.UpdatedAt = time.UnixMilli(env.TS)
	tc := tickerCache{Price: price.String(), TS: env.TS}
	if s.FundingRate != nil {
		tc.FundingRt = s.FundingRate.String()
	}
	if s.OpenInterest != nil {
		tc.OI = s.OpenInterest.String()
	}
	a.mu.Unlock()

	a.writeTickerCache(ctx, exchange, symbol, tc)
}

// OnBook applies an L2 update to the local mirror, refreshes cache:book, and
// recomputes the spread.
func (a *Aggregator) OnBook(ctx context.Context, exchange, symbol string, env norm.Envelope, book norm.Book) {
	a.mu.Lock()
	b := a.bookFor(exchange, symbol)
	b.apply(book)
	bid, ask := b.bestBid(), b.bestAsk()
	s := a.stateFor(exchange, symbol)
	s.Spread = spreadFraction(bid, ask)
	bids, asks := b.snapshot()
	a.mu.Unlock()

	payload, err := json.Marshal(bookCache{Bids: bids, Asks: asks, TS: env.TS, BookSeq: book.BookSeq})
	if err != nil {
		a.log.Error("store: marshal book cache", "err", err)
		return
	}
	if err := a.redis.Set(ctx, bookCacheKey(exchange, symbol), payload, 0).Err(); err != nil {
		a.log.Error("store: write book cache", "err", err, "exchange", exchange, "sym", symbol)
	}
}

// OnCandle persists final buckets only — an in-progress candle isn't a
// settled data point yet (matches the hypertable's append-only design).
func (a *Aggregator) OnCandle(ctx context.Context, exchange, symbol string, env norm.Envelope, candle norm.Candle) {
	if !candle.Final {
		return
	}
	row, ok := candleRowFrom(exchange, symbol, env, candle, a.log)
	if !ok {
		return
	}
	if err := a.w.InsertCandle(ctx, row); err != nil {
		a.log.Error("store: insert candle failed", "err", err, "exchange", exchange, "sym", symbol, "tf", candle.TF)
	}
}

func candleRowFrom(exchange, symbol string, env norm.Envelope, c norm.Candle, log *slog.Logger) (CandleRow, bool) {
	open, err1 := decimal.NewFromString(c.Open)
	high, err2 := decimal.NewFromString(c.High)
	low, err3 := decimal.NewFromString(c.Low)
	closeP, err4 := decimal.NewFromString(c.Close)
	volume, err5 := decimal.NewFromString(c.Volume)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		log.Warn("store: malformed candle payload", "exchange", exchange, "sym", symbol, "tf", c.TF)
		return CandleRow{}, false
	}
	row := CandleRow{
		Exchange: exchange, Symbol: symbol, TF: c.TF, TS: time.UnixMilli(env.TS),
		Open: open, High: high, Low: low, Close: closeP, Volume: volume,
	}
	if c.QuoteVolume != "" {
		if qv, err := decimal.NewFromString(c.QuoteVolume); err == nil {
			row.QuoteVolume = &qv
		}
	}
	if c.TradeCount > 0 {
		tc := c.TradeCount
		row.TradeCount = &tc
	}
	return row, true
}

// OnFunding updates the live funding rate and persists to the hypertable.
func (a *Aggregator) OnFunding(ctx context.Context, exchange, symbol string, env norm.Envelope, f norm.Funding) {
	rate, err := decimal.NewFromString(f.Rate)
	if err != nil {
		a.log.Warn("store: malformed funding rate", "exchange", exchange, "sym", symbol)
		return
	}
	a.mu.Lock()
	s := a.stateFor(exchange, symbol)
	s.FundingRate = &rate
	a.mu.Unlock()

	row := FundingRow{Exchange: exchange, Symbol: symbol, TS: time.UnixMilli(env.TS), Rate: rate}
	if f.NextFundingTS > 0 {
		t := time.UnixMilli(f.NextFundingTS)
		row.NextFundingTS = &t
	}
	if err := a.w.InsertFunding(ctx, row); err != nil {
		a.log.Error("store: insert funding failed", "err", err, "exchange", exchange, "sym", symbol)
	}
}

// OnTicker applies a venue's own rolling 24h stats (P1.5e) — the authoritative
// source for the screener's volume_24h/change_24h.
//
// Why this exists: those two fields used to be derived exclusively by summing
// OUR OWN recorded 1h candles (recomputeOne -> Volume24h/PriorClose), and
// OnCandle only persists a bucket once it's FINAL. So a freshly started process
// had no candle history and left volume_24h NULL for every symbol — and since
// the screener's `volume_24h > 0` filter can never match NULL, almost every
// coin (including all of Binance) silently vanished from the table. A venue's
// 24h ticker is correct on the first message, so it fixes both the coin count
// and the nonsense partial-window volumes.
//
// Price is updated here too: many venues push tickers for symbols that trade
// thinly enough to go long stretches without an aggTrade, and a symbol with no
// price is skipped by recomputeOne entirely.
func (a *Aggregator) OnTicker(ctx context.Context, exchange, symbol string, env norm.Envelope, tk norm.Ticker) {
	// Prefer quote volume (USDT) when the venue reports it: it's comparable
	// across symbols at wildly different price levels, which is the whole point
	// of a volume sort. Falls back to base volume otherwise. Same COALESCE
	// preference the candle-derived Volume24h query already uses.
	volStr := tk.QuoteVolume24h
	if volStr == "" {
		volStr = tk.Volume24h
	}

	a.mu.Lock()
	s := a.stateFor(exchange, symbol)
	if v, err := decimal.NewFromString(volStr); err == nil && volStr != "" {
		s.Volume24h = &v
		s.venueVolume24h = true
	}
	if tk.Change24h != "" {
		if c, err := decimal.NewFromString(tk.Change24h); err == nil {
			s.Change24h = &c
			s.venueChange24h = true
		}
	}
	if tk.Last != "" {
		if p, err := decimal.NewFromString(tk.Last); err == nil {
			s.Price = &p
		}
	}
	s.UpdatedAt = time.UnixMilli(env.TS)
	tc := tickerCache{TS: env.TS}
	if s.Price != nil {
		tc.Price = s.Price.String()
	}
	if s.FundingRate != nil {
		tc.FundingRt = s.FundingRate.String()
	}
	if s.OpenInterest != nil {
		tc.OI = s.OpenInterest.String()
	}
	a.mu.Unlock()

	if tc.Price != "" {
		a.writeTickerCache(ctx, exchange, symbol, tc)
	}
}

// OnOI updates the live open-interest reading and persists to the
// hypertable.
func (a *Aggregator) OnOI(ctx context.Context, exchange, symbol string, env norm.Envelope, oi norm.OI) {
	val, err := decimal.NewFromString(oi.OpenInterest)
	if err != nil {
		a.log.Warn("store: malformed OI", "exchange", exchange, "sym", symbol)
		return
	}
	a.mu.Lock()
	s := a.stateFor(exchange, symbol)
	s.OpenInterest = &val
	a.mu.Unlock()

	row := OIRow{Exchange: exchange, Symbol: symbol, TS: time.UnixMilli(env.TS), OpenInterest: val}
	if oi.OpenInterestUSD != "" {
		if usd, err := decimal.NewFromString(oi.OpenInterestUSD); err == nil {
			row.OpenInterestUSD = &usd
		}
	}
	if err := a.w.InsertOI(ctx, row); err != nil {
		a.log.Error("store: insert oi failed", "err", err, "exchange", exchange, "sym", symbol)
	}
}

func (a *Aggregator) writeTickerCache(ctx context.Context, exchange, symbol string, tc tickerCache) {
	payload, err := json.Marshal(tc)
	if err != nil {
		a.log.Error("store: marshal ticker cache", "err", err)
		return
	}
	if err := a.redis.Set(ctx, tickerCacheKey(exchange, symbol), payload, 10*time.Second).Err(); err != nil {
		a.log.Error("store: write ticker cache", "err", err, "exchange", exchange, "sym", symbol)
	}
}

// Forget drops all state for a symbol that has delisted (P1.5c): the in-memory
// instrument_state + local book, the Redis cache:ticker/cache:book keys, and
// the Postgres instrument_state row. The hypertables (candles/funding/oi) are
// append-only history and deliberately kept. Safe to call for a symbol we
// never saw. Implements supervisor.Pruner.
func (a *Aggregator) Forget(ctx context.Context, exchange, symbol string) {
	k := key(exchange, symbol)
	a.mu.Lock()
	delete(a.states, k)
	delete(a.books, k)
	a.mu.Unlock()

	if err := a.redis.Del(ctx, tickerCacheKey(exchange, symbol), bookCacheKey(exchange, symbol)).Err(); err != nil {
		a.log.Warn("store: delete cache keys on forget", "err", err, "exchange", exchange, "sym", symbol)
	}
	if err := a.w.DeleteInstrumentState(ctx, exchange, symbol); err != nil {
		a.log.Error("store: delete instrument_state on forget", "err", err, "exchange", exchange, "sym", symbol)
	}
}

// Run starts the flush and recompute loops; blocks until ctx is cancelled.
func (a *Aggregator) Run(ctx context.Context) {
	go a.flushLoop(ctx)
	a.recomputeLoop(ctx) // caller runs Run in its own goroutine; recompute owns this one
}

func (a *Aggregator) flushLoop(ctx context.Context) {
	for {
		select {
		case <-a.clock.After(a.flushInterval):
			a.flushOnce(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (a *Aggregator) flushOnce(ctx context.Context) {
	a.mu.Lock()
	snapshot := make([]InstrumentState, 0, len(a.states))
	for _, s := range a.states {
		snapshot = append(snapshot, *s)
	}
	a.mu.Unlock()

	for _, s := range snapshot {
		if s.UpdatedAt.IsZero() {
			continue // never ticked yet; nothing to flush
		}
		if err := a.w.UpsertInstrumentState(ctx, s); err != nil {
			a.log.Error("store: flush instrument_state failed", "err", err, "exchange", s.Exchange, "sym", s.Symbol)
		}
	}
}

func (a *Aggregator) recomputeLoop(ctx context.Context) {
	for {
		select {
		case <-a.clock.After(a.recomputeInterval):
			a.recomputeOnce(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (a *Aggregator) recomputeOnce(ctx context.Context) {
	a.mu.Lock()
	keys := make([][2]string, 0, len(a.states))
	for _, s := range a.states {
		keys = append(keys, [2]string{s.Exchange, s.Symbol})
	}
	a.mu.Unlock()

	now := a.clock.Now()
	for _, k := range keys {
		exchange, symbol := k[0], k[1]
		a.recomputeOne(ctx, exchange, symbol, now)
	}
}

func (a *Aggregator) recomputeOne(ctx context.Context, exchange, symbol string, now time.Time) {
	a.mu.Lock()
	s := a.states[key(exchange, symbol)]
	var current *decimal.Decimal
	if s != nil {
		current = s.Price
	}
	a.mu.Unlock()
	if current == nil {
		return // no live price yet; derived stats are meaningless without a baseline
	}

	prior1h, err := a.w.PriorClose(ctx, exchange, symbol, "1h", now.Add(-time.Hour))
	if err != nil {
		a.log.Error("store: recompute change_1h failed", "err", err, "exchange", exchange, "sym", symbol)
	}
	prior24h, err := a.w.PriorClose(ctx, exchange, symbol, "1h", now.Add(-24*time.Hour))
	if err != nil {
		a.log.Error("store: recompute change_24h failed", "err", err, "exchange", exchange, "sym", symbol)
	}
	prior7d, err := a.w.PriorClose(ctx, exchange, symbol, "1d", now.Add(-7*24*time.Hour))
	if err != nil {
		a.log.Error("store: recompute change_7d failed", "err", err, "exchange", exchange, "sym", symbol)
	}
	vol24h, err := a.w.Volume24h(ctx, exchange, symbol)
	if err != nil {
		a.log.Error("store: recompute volume_24h failed", "err", err, "exchange", exchange, "sym", symbol)
	}
	closes, err := a.w.RecentCloses(ctx, exchange, symbol, "1h", now.Add(-25*time.Hour))
	if err != nil {
		a.log.Error("store: recompute volatility_24h failed", "err", err, "exchange", exchange, "sym", symbol)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	s = a.states[key(exchange, symbol)]
	if s == nil {
		return // symbol was dropped between the snapshot and now; nothing to update
	}
	if prior1h != nil {
		s.Change1h = percentChange(*current, *prior1h)
	}
	// The venue's own 24h figures win over anything we derive from candles: ours
	// are only as complete as our uptime (see OnTicker). Without these guards a
	// recompute would overwrite a correct venue volume with a partial-window sum
	// — or with nil, re-hiding the symbol from the `volume_24h > 0` filter.
	if prior24h != nil && !s.venueChange24h {
		s.Change24h = percentChange(*current, *prior24h)
	}
	if prior7d != nil {
		s.Change7d = percentChange(*current, *prior7d)
	}
	if !s.venueVolume24h {
		s.Volume24h = vol24h
	}
	s.Volatility24h = volatility24h(closes)
}
