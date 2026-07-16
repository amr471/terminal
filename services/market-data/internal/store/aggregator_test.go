package store

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/norm"
)

// fakeWriter drives the Aggregator without a real Postgres — mirrors the
// fakeFeed pattern in internal/conn/manager_test.go.
type fakeWriter struct {
	mu         sync.Mutex
	upserts    []InstrumentState
	deletes    []string // exchange|symbol
	candles    []CandleRow
	fundings   []FundingRow
	ois        []OIRow
	priorClose map[string]*decimal.Decimal // key: exchange|symbol|tf
	recent     map[string][]decimal.Decimal
	volume     map[string]*decimal.Decimal
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{
		priorClose: map[string]*decimal.Decimal{},
		recent:     map[string][]decimal.Decimal{},
		volume:     map[string]*decimal.Decimal{},
	}
}

func (f *fakeWriter) UpsertInstrumentState(_ context.Context, s InstrumentState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, s)
	return nil
}
func (f *fakeWriter) DeleteInstrumentState(_ context.Context, exchange, symbol string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, exchange+"|"+symbol)
	return nil
}
func (f *fakeWriter) InsertCandle(_ context.Context, c CandleRow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.candles = append(f.candles, c)
	return nil
}
func (f *fakeWriter) InsertFunding(_ context.Context, r FundingRow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fundings = append(f.fundings, r)
	return nil
}
func (f *fakeWriter) InsertOI(_ context.Context, o OIRow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ois = append(f.ois, o)
	return nil
}
func (f *fakeWriter) PriorClose(_ context.Context, exchange, symbol, tf string, _ time.Time) (*decimal.Decimal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.priorClose[exchange+"|"+symbol+"|"+tf], nil
}
func (f *fakeWriter) RecentCloses(_ context.Context, exchange, symbol, tf string, _ time.Time) ([]decimal.Decimal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.recent[exchange+"|"+symbol+"|"+tf], nil
}
func (f *fakeWriter) Volume24h(_ context.Context, exchange, symbol string) (*decimal.Decimal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.volume[exchange+"|"+symbol], nil
}

func (f *fakeWriter) lastUpsert() (InstrumentState, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.upserts) == 0 {
		return InstrumentState{}, false
	}
	return f.upserts[len(f.upserts)-1], true
}

// fakeClock lets tests fire flush/recompute ticks deterministically instead
// of sleeping, same testability contract conn.Clock already gives Manager.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
	chs []chan time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Unix(0, 0)} }

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

func (c *fakeClock) After(time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.chs = append(c.chs, ch)
	return ch
}

// fire sends a tick on every channel handed out so far and advances now().
func (c *fakeClock) fire() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(time.Second)
	for _, ch := range c.chs {
		select {
		case ch <- c.now:
		default:
		}
	}
	c.chs = nil
}

func newTestAggregator(t *testing.T) (*Aggregator, *fakeWriter, *fakeClock, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	fw := newFakeWriter()
	clock := newFakeClock()
	log := slog.New(slog.DiscardHandler)
	agg := NewAggregator(fw, client, log).WithClock(clock)
	return agg, fw, clock, mr
}

func TestAggregator_OnTrade_UpdatesPriceAndTickerCache(t *testing.T) {
	agg, _, _, mr := newTestAggregator(t)
	ctx := context.Background()

	env := norm.Envelope{V: 1, Type: norm.TypeTrade, Src: "binance", Sym: "btcusdt", TS: 1000}
	agg.OnTrade(ctx, "binance", "btcusdt", env, norm.Trade{Price: "64123.50", Qty: "1", Side: "buy"})

	agg.mu.Lock()
	s := agg.states[key("binance", "btcusdt")]
	agg.mu.Unlock()
	if s == nil || s.Price == nil || !s.Price.Equal(dec("64123.50")) {
		t.Fatalf("price = %v, want 64123.50", s)
	}

	raw, err := mr.Get("cache:ticker:binance:btcusdt")
	if err != nil {
		t.Fatalf("cache:ticker not written: %v", err)
	}
	var tc tickerCache
	if err := json.Unmarshal([]byte(raw), &tc); err != nil {
		t.Fatal(err)
	}
	if tc.Price != "64123.5" {
		t.Errorf("ticker cache price = %q, want 64123.5", tc.Price)
	}
	ttl := mr.TTL("cache:ticker:binance:btcusdt")
	if ttl <= 0 || ttl > 10*time.Second {
		t.Errorf("ticker cache TTL = %v, want (0,10s]", ttl)
	}
}

func TestAggregator_Forget_ClearsStateCachesAndRow(t *testing.T) {
	agg, fw, _, mr := newTestAggregator(t)
	ctx := context.Background()

	env := norm.Envelope{V: 1, Type: norm.TypeTrade, Src: "binance", Sym: "btcusdt", TS: 1000}
	agg.OnTrade(ctx, "binance", "btcusdt", env, norm.Trade{Price: "64000", Qty: "1", Side: "buy"})
	agg.OnBook(ctx, "binance", "btcusdt", env, norm.Book{Bids: [][2]string{{"63999", "1"}}, Asks: [][2]string{{"64001", "1"}}, Snapshot: true})
	if _, err := mr.Get("cache:ticker:binance:btcusdt"); err != nil {
		t.Fatal("precondition: ticker cache should exist")
	}

	agg.Forget(ctx, "binance", "btcusdt")

	agg.mu.Lock()
	_, hasState := agg.states[key("binance", "btcusdt")]
	_, hasBook := agg.books[key("binance", "btcusdt")]
	agg.mu.Unlock()
	if hasState || hasBook {
		t.Fatalf("in-memory state not cleared: state=%v book=%v", hasState, hasBook)
	}
	if mr.Exists("cache:ticker:binance:btcusdt") || mr.Exists("cache:book:binance:btcusdt") {
		t.Fatal("redis cache keys not deleted on forget")
	}
	fw.mu.Lock()
	defer fw.mu.Unlock()
	if len(fw.deletes) != 1 || fw.deletes[0] != "binance|btcusdt" {
		t.Fatalf("instrument_state delete = %v, want [binance|btcusdt]", fw.deletes)
	}
}

func TestAggregator_OnBook_MaintainsCacheAndSpread(t *testing.T) {
	agg, _, _, mr := newTestAggregator(t)
	ctx := context.Background()

	env := norm.Envelope{V: 1, Type: norm.TypeBook, Src: "binance", Sym: "btcusdt", TS: 1000}
	book := norm.Book{Snapshot: true, Bids: [][2]norm.Dec{{"99", "1"}}, Asks: [][2]norm.Dec{{"101", "1"}}}
	agg.OnBook(ctx, "binance", "btcusdt", env, book)

	agg.mu.Lock()
	s := agg.states[key("binance", "btcusdt")]
	agg.mu.Unlock()
	if s == nil || s.Spread == nil || !s.Spread.Equal(dec("0.02")) {
		t.Fatalf("spread = %v, want 0.02", s)
	}

	if !mr.Exists("cache:book:binance:btcusdt") {
		t.Fatal("cache:book not written")
	}
	if ttl := mr.TTL("cache:book:binance:btcusdt"); ttl != 0 {
		t.Errorf("cache:book TTL = %v, want 0 (no expiry, overwritten in place)", ttl)
	}
}

func TestAggregator_OnCandle_OnlyPersistsFinalBuckets(t *testing.T) {
	agg, fw, _, _ := newTestAggregator(t)
	ctx := context.Background()
	env := norm.Envelope{V: 1, Type: norm.TypeCandle, Src: "binance", Sym: "btcusdt", TS: 60000}

	agg.OnCandle(ctx, "binance", "btcusdt", env, norm.Candle{
		TF: "1m", Open: "100", High: "101", Low: "99", Close: "100.5", Volume: "10", Final: false,
	})
	if len(fw.candles) != 0 {
		t.Fatalf("non-final candle was persisted: %d rows", len(fw.candles))
	}

	agg.OnCandle(ctx, "binance", "btcusdt", env, norm.Candle{
		TF: "1m", Open: "100", High: "101", Low: "99", Close: "100.5", Volume: "10", Final: true,
	})
	if len(fw.candles) != 1 {
		t.Fatalf("final candle not persisted: %d rows", len(fw.candles))
	}
	if !fw.candles[0].Close.Equal(dec("100.5")) {
		t.Errorf("close = %v, want 100.5", fw.candles[0].Close)
	}
}

func TestAggregator_OnFunding_UpdatesStateAndPersists(t *testing.T) {
	agg, fw, _, _ := newTestAggregator(t)
	ctx := context.Background()
	env := norm.Envelope{V: 1, Type: norm.TypeFunding, Src: "okx", Sym: "btcusdt", TS: 1000}
	agg.OnFunding(ctx, "okx", "btcusdt", env, norm.Funding{Rate: "0.0001"})

	agg.mu.Lock()
	s := agg.states[key("okx", "btcusdt")]
	agg.mu.Unlock()
	if s == nil || s.FundingRate == nil || !s.FundingRate.Equal(dec("0.0001")) {
		t.Fatalf("funding rate = %v, want 0.0001", s)
	}
	if len(fw.fundings) != 1 {
		t.Fatalf("funding not persisted: %d rows", len(fw.fundings))
	}
}

func TestAggregator_OnOI_UpdatesStateAndPersists(t *testing.T) {
	agg, fw, _, _ := newTestAggregator(t)
	ctx := context.Background()
	env := norm.Envelope{V: 1, Type: norm.TypeOI, Src: "bybit", Sym: "solusdt", TS: 1000}
	agg.OnOI(ctx, "bybit", "solusdt", env, norm.OI{OpenInterest: "95000000"})

	agg.mu.Lock()
	s := agg.states[key("bybit", "solusdt")]
	agg.mu.Unlock()
	if s == nil || s.OpenInterest == nil || !s.OpenInterest.Equal(dec("95000000")) {
		t.Fatalf("OI = %v, want 95000000", s)
	}
	if len(fw.ois) != 1 {
		t.Fatalf("OI not persisted: %d rows", len(fw.ois))
	}
}

func TestAggregator_FlushLoop_UpsertsTickedSymbolsOnly(t *testing.T) {
	agg, fw, clock, _ := newTestAggregator(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go agg.Run(ctx)
	// Let both loops register their After() channels before ticking.
	waitForAggCond(t, func() bool { clock.mu.Lock(); defer clock.mu.Unlock(); return len(clock.chs) >= 2 })

	env := norm.Envelope{V: 1, Type: norm.TypeTrade, Src: "binance", Sym: "btcusdt", TS: 1000}
	agg.OnTrade(ctx, "binance", "btcusdt", env, norm.Trade{Price: "100", Qty: "1", Side: "buy"})

	clock.fire() // fires both flush and recompute (both are due at the same fake-clock instant)
	waitForAggCond(t, func() bool { _, ok := fw.lastUpsert(); return ok })

	got, _ := fw.lastUpsert()
	if got.Exchange != "binance" || got.Symbol != "btcusdt" {
		t.Fatalf("flushed wrong instrument: %+v", got)
	}
	if got.Price == nil || !got.Price.Equal(dec("100")) {
		t.Fatalf("flushed price = %v, want 100", got.Price)
	}
}

func TestAggregator_Recompute_ComputesChangeFromPriorClose(t *testing.T) {
	agg, fw, clock, _ := newTestAggregator(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	env := norm.Envelope{V: 1, Type: norm.TypeTrade, Src: "binance", Sym: "btcusdt", TS: 1000}
	agg.OnTrade(ctx, "binance", "btcusdt", env, norm.Trade{Price: "110", Qty: "1", Side: "buy"})

	prior := dec("100")
	fw.priorClose["binance|btcusdt|1h"] = &prior

	go agg.Run(ctx)
	waitForAggCond(t, func() bool { clock.mu.Lock(); defer clock.mu.Unlock(); return len(clock.chs) >= 2 })
	clock.fire()

	waitForAggCond(t, func() bool {
		agg.mu.Lock()
		defer agg.mu.Unlock()
		s := agg.states[key("binance", "btcusdt")]
		return s != nil && s.Change1h != nil
	})

	agg.mu.Lock()
	s := agg.states[key("binance", "btcusdt")]
	agg.mu.Unlock()
	if !s.Change1h.Equal(dec("0.1")) {
		t.Errorf("change_1h = %v, want 0.1 (110 vs 100 baseline)", s.Change1h)
	}
}

func waitForAggCond(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition never became true")
}
