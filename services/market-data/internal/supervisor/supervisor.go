package supervisor

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/health"
)

// Config tunes the dynamic universe. Defaults are applied by New for any
// zero-value field.
type Config struct {
	// MaxSymbolsPerVenue caps how many instruments we subscribe per venue
	// (P1.5c: the full universe is thousands; a cap bounds connection and
	// Postgres load). 0 means uncapped.
	MaxSymbolsPerVenue int
	// DiscoveryInterval is how often each venue's instrument list is polled
	// for listings/delistings.
	DiscoveryInterval time.Duration
}

const (
	defaultMaxSymbolsPerVenue = 200
	defaultDiscoveryInterval  = 5 * time.Minute
)

// Pruner is notified when a symbol delists so downstream state (instrument_state,
// caches) can be cleaned up. store.Aggregator implements it; nil disables
// pruning (e.g. Postgres-less runs).
type Pruner interface {
	Forget(ctx context.Context, exchange, symbol string)
}

// Supervisor drives per-venue discovery + runtime shard lifecycle. One
// discovery goroutine per venue owns that venue's running-shards map, so the
// map needs no lock; each shard's feed managers run under a per-shard context
// that is a child of the venue context, so cancelling the supervisor (or a
// single shard) tears down exactly the right connections.
type Supervisor struct {
	registry *exchange.Registry
	sink     conn.Sink
	states   *health.Registry
	pruner   Pruner
	log      *slog.Logger
	clock    conn.Clock
	cfg      Config
}

// New builds a Supervisor. clock may be nil (RealClock is used); tests pass a
// fake clock. pruner may be nil (no delist cleanup, e.g. Postgres-less runs).
func New(registry *exchange.Registry, sink conn.Sink, states *health.Registry, pruner Pruner, log *slog.Logger, clock conn.Clock, cfg Config) *Supervisor {
	if cfg.MaxSymbolsPerVenue == 0 {
		cfg.MaxSymbolsPerVenue = defaultMaxSymbolsPerVenue
	}
	if cfg.DiscoveryInterval <= 0 {
		cfg.DiscoveryInterval = defaultDiscoveryInterval
	}
	if clock == nil {
		clock = conn.RealClock{}
	}
	return &Supervisor{registry: registry, sink: sink, states: states, pruner: pruner, log: log, clock: clock, cfg: cfg}
}

// Run starts a discovery loop per venue and blocks until ctx is cancelled, at
// which point every venue loop stops and every shard's managers are torn down.
func (s *Supervisor) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, a := range s.registry.Adapters() {
		wg.Add(1)
		go func(a exchange.Adapter) {
			defer wg.Done()
			s.runVenue(ctx, a)
		}(a)
	}
	wg.Wait()
}

// runShard is one live shard: the symbols it serves, a cancel to stop its
// managers, and a WaitGroup that closes when they've all exited.
type runShard struct {
	symbols []string
	cancel  context.CancelFunc
	done    *sync.WaitGroup
}

func (s *Supervisor) runVenue(ctx context.Context, a exchange.Adapter) {
	log := s.log.With("venue", a.Name())
	size := shardSize(a.Limits().MaxStreamsPerConn, a.StreamsPerSymbol())
	count := shardCount(s.cfg.MaxSymbolsPerVenue, size)
	running := map[int]*runShard{}
	live := map[string]bool{} // symbols currently subscribed for this venue

	discover := func() {
		syms, err := a.Instruments(ctx)
		if err != nil {
			log.Warn("instrument discovery failed; keeping current shards", "err", err, "code", "MD-1004")
			return
		}
		capped := applyCap(syms, s.cfg.MaxSymbolsPerVenue)
		s.reconcile(ctx, a, log, running, assignShards(capped, count))
		s.prune(ctx, a.Name(), live, capped)
		log.Info("universe reconciled", "symbols", len(syms), "subscribed", len(live), "shards", len(running))
	}

	discover() // immediate first pass, don't wait a full interval for any data

	for {
		select {
		case <-s.clock.After(s.cfg.DiscoveryInterval):
			discover()
		case <-ctx.Done():
			s.stopAll(running)
			return
		}
	}
}

// reconcile applies one discovery cycle: stop shards that changed or delisted,
// start new/changed ones. Runs only on the venue goroutine, so `running` is
// touched by a single goroutine.
func (s *Supervisor) reconcile(ctx context.Context, a exchange.Adapter, log *slog.Logger, running map[int]*runShard, desired map[int][]string) {
	cur := make(map[int][]string, len(running))
	for slot, sh := range running {
		cur[slot] = sh.symbols
	}
	plan := planReconcile(cur, desired)
	if plan.empty() {
		return
	}
	for _, slot := range plan.stop {
		if sh := running[slot]; sh != nil {
			sh.cancel()
			delete(running, slot)
		}
	}
	for slot, symbols := range plan.start {
		running[slot] = s.startShard(ctx, a, log, symbols)
	}
}

// prune reconciles the venue's live-symbol set against the freshly discovered
// one: symbols that dropped out are forgotten (instrument_state row + caches
// cleared) so downstream consumers never see delisted instruments. Mutates
// live in place. Runs on the venue goroutine.
func (s *Supervisor) prune(ctx context.Context, exchange string, live map[string]bool, discovered []string) {
	want := make(map[string]bool, len(discovered))
	for _, sym := range discovered {
		want[sym] = true
		live[sym] = true
	}
	for sym := range live {
		if want[sym] {
			continue
		}
		delete(live, sym)
		if s.pruner != nil {
			s.pruner.Forget(ctx, exchange, sym)
		}
	}
}

// startShard builds the venue's feeds for a symbol subset and runs one manager
// per feed under a fresh child context. Cancelling that context stops the
// managers and closes their connections (conn.Manager.Run closes the feed
// after its consume loop returns on cancel).
func (s *Supervisor) startShard(ctx context.Context, a exchange.Adapter, log *slog.Logger, symbols []string) *runShard {
	shardCtx, cancel := context.WithCancel(ctx)
	done := &sync.WaitGroup{}
	for _, feed := range a.Feeds(symbols, log) {
		mgr := conn.NewManager(feed, s.sink, s.states, log)
		done.Add(1)
		go func() {
			defer done.Done()
			mgr.Run(shardCtx)
		}()
	}
	return &runShard{symbols: symbols, cancel: cancel, done: done}
}

// stopAll cancels every running shard and waits for its managers to exit, so
// shutdown is clean (no leaked goroutines or sockets).
func (s *Supervisor) stopAll(running map[int]*runShard) {
	shards := make([]*runShard, 0, len(running))
	for slot, sh := range running {
		sh.cancel()
		shards = append(shards, sh)
		delete(running, slot)
	}
	// Contexts are children of the (now-cancelled) venue ctx, so the managers
	// are already unwinding; wait for them so Run returns only once they're
	// truly done.
	for _, sh := range shards {
		sh.done.Wait()
	}
}
