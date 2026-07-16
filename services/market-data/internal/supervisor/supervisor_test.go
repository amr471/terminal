package supervisor

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/health"
)

// fakeFeed is a conn.Feed that never produces messages; it just records
// connect/close so a test can observe the shard lifecycle. ExpectedInterval is
// huge so the manager's staleness timer never fires during a short test.
type fakeFeed struct {
	name      string
	connected atomic.Int32
	closed    atomic.Int32
	msgs      chan conn.RawMsg
	mu        sync.Mutex
}

func (f *fakeFeed) Name() string                    { return f.name }
func (f *fakeFeed) ExpectedInterval() time.Duration { return time.Hour }
func (f *fakeFeed) Connect(context.Context) error {
	f.mu.Lock()
	f.msgs = make(chan conn.RawMsg)
	f.mu.Unlock()
	f.connected.Add(1)
	return nil
}
func (f *fakeFeed) Messages() <-chan conn.RawMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.msgs
}
func (f *fakeFeed) Resync(context.Context) error { return nil }
func (f *fakeFeed) Close() error {
	f.closed.Add(1)
	return nil
}

// fakeVenue is an exchange.Adapter whose Feeds returns one fresh fakeFeed per
// call, recorded so the test can inspect connect/close counts.
type fakeVenue struct {
	mu    sync.Mutex
	feeds []*fakeFeed
	max   int // MaxStreamsPerConn
	per   int // StreamsPerSymbol
	insts []string
}

func (v *fakeVenue) Name() string                                  { return "fake" }
func (v *fakeVenue) WireSymbol(s string) (string, bool)            { return s, s != "" }
func (v *fakeVenue) ProvidedKinds() []string                       { return []string{"trades"} }
func (v *fakeVenue) Limits() exchange.Limits                       { return exchange.Limits{MaxStreamsPerConn: v.max} }
func (v *fakeVenue) StreamsPerSymbol() int                         { return v.per }
func (v *fakeVenue) Instruments(context.Context) ([]string, error) { return v.insts, nil }
func (v *fakeVenue) Feeds(symbols []string, _ *slog.Logger) []conn.Feed {
	f := &fakeFeed{name: "fake." + symbolsKey(symbols)}
	v.mu.Lock()
	v.feeds = append(v.feeds, f)
	v.mu.Unlock()
	return []conn.Feed{f}
}

func symbolsKey(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += ","
		}
		out += x
	}
	return out
}

type noopSink struct{}

func (noopSink) Publish(context.Context, conn.RawMsg) error { return nil }

func newTestSup() *Supervisor {
	return New(nil, noopSink{}, health.NewRegistry(), nil,
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil, Config{})
}

// fakePruner records Forget calls (exchange|symbol).
type fakePruner struct {
	mu     sync.Mutex
	forgot []string
}

func (p *fakePruner) Forget(_ context.Context, exchange, symbol string) {
	p.mu.Lock()
	p.forgot = append(p.forgot, exchange+"|"+symbol)
	p.mu.Unlock()
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartShardConnectsThenCancelCloses(t *testing.T) {
	sup := newTestSup()
	v := &fakeVenue{}
	ctx, cancel := context.WithCancel(context.Background())

	sh := sup.startShard(ctx, v, sup.log, []string{"btcusdt"})
	waitFor(t, "feed connect", func() bool { return v.feeds[0].connected.Load() == 1 })

	cancel()
	done := make(chan struct{})
	go func() { sh.done.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("shard managers did not exit after cancel")
	}
	if v.feeds[0].closed.Load() == 0 {
		t.Fatal("feed was not closed on shard cancel")
	}
}

func TestReconcileStartsStopsRestarts(t *testing.T) {
	sup := newTestSup()
	v := &fakeVenue{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	running := map[int]*runShard{}

	// Start two shards.
	sup.reconcile(ctx, v, sup.log, running, map[int][]string{0: {"btcusdt"}, 1: {"ethusdt"}})
	if len(running) != 2 {
		t.Fatalf("running = %d shards, want 2", len(running))
	}
	waitFor(t, "both feeds connect", func() bool {
		v.mu.Lock()
		defer v.mu.Unlock()
		return len(v.feeds) == 2 && v.feeds[0].connected.Load() == 1 && v.feeds[1].connected.Load() == 1
	})
	slot1Feed := v.feeds[1]

	// eth delists -> slot 1 stops.
	sup.reconcile(ctx, v, sup.log, running, map[int][]string{0: {"btcusdt"}})
	if len(running) != 1 {
		t.Fatalf("after delist running = %d, want 1", len(running))
	}
	waitFor(t, "slot1 feed close", func() bool { return slot1Feed.closed.Load() == 1 })

	// slot 0 membership changes -> restart (old closes, new connects).
	slot0Feed := v.feeds[0]
	sup.reconcile(ctx, v, sup.log, running, map[int][]string{0: {"btcusdt", "solusdt"}})
	waitFor(t, "slot0 restart: old closes", func() bool { return slot0Feed.closed.Load() == 1 })
	waitFor(t, "slot0 restart: new connects", func() bool {
		v.mu.Lock()
		defer v.mu.Unlock()
		return len(v.feeds) == 3 && v.feeds[2].connected.Load() == 1
	})

	// Shut everything down cleanly.
	sup.stopAll(running)
	if len(running) != 0 {
		t.Fatalf("stopAll left %d shards", len(running))
	}
}

func TestShardCountFromVenueLimits(t *testing.T) {
	// MaxStreamsPerConn 30, StreamsPerSymbol 8 -> shardSize 3; with a 200 cap
	// that's ceil(200/3)=67 slots. Just sanity-check the wiring via New's
	// default cap being applied.
	sup := New(nil, noopSink{}, health.NewRegistry(), nil,
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil, Config{})
	if sup.cfg.MaxSymbolsPerVenue != defaultMaxSymbolsPerVenue {
		t.Fatalf("default cap = %d", sup.cfg.MaxSymbolsPerVenue)
	}
	if sup.cfg.DiscoveryInterval != defaultDiscoveryInterval {
		t.Fatalf("default interval = %v", sup.cfg.DiscoveryInterval)
	}
}

func TestPruneForgetsDelistedSymbols(t *testing.T) {
	p := &fakePruner{}
	sup := New(nil, noopSink{}, health.NewRegistry(), p,
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil, Config{})
	live := map[string]bool{}

	// First cycle: btc + eth become live, nothing forgotten.
	sup.prune(context.Background(), "binance", live, []string{"btcusdt", "ethusdt"})
	if len(p.forgot) != 0 || len(live) != 2 {
		t.Fatalf("first prune: forgot=%v live=%d", p.forgot, len(live))
	}

	// Second cycle: eth delists -> forgotten; btc stays.
	sup.prune(context.Background(), "binance", live, []string{"btcusdt"})
	if len(p.forgot) != 1 || p.forgot[0] != "binance|ethusdt" {
		t.Fatalf("forgot = %v, want [binance|ethusdt]", p.forgot)
	}
	if live["ethusdt"] || !live["btcusdt"] {
		t.Fatalf("live = %v", live)
	}
}
