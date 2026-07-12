package conn

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/terminal/market-data/internal/health"
	"github.com/terminal/market-data/internal/norm"
)

// fakeFeed drives the manager without any network. Short ExpectedInterval
// keeps staleness tests fast (staleAfter = 3×interval = 15ms).
type fakeFeed struct {
	mu         sync.Mutex
	msgs       chan RawMsg
	connects   atomic.Int32
	resyncs    atomic.Int32
	connectErr error
	interval   time.Duration
}

func newFakeFeed() *fakeFeed { return &fakeFeed{interval: 5 * time.Millisecond} }

func (f *fakeFeed) Name() string                    { return "fake.ws" }
func (f *fakeFeed) ExpectedInterval() time.Duration { return f.interval }

func (f *fakeFeed) Connect(context.Context) error {
	f.connects.Add(1)
	if f.connectErr != nil {
		return f.connectErr
	}
	f.mu.Lock()
	f.msgs = make(chan RawMsg, 16)
	f.mu.Unlock()
	return nil
}

func (f *fakeFeed) Messages() <-chan RawMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.msgs
}

func (f *fakeFeed) send(seq uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs <- RawMsg{
		Channel: norm.Channel{Exchange: "binance", Symbol: "btcusdt", Kind: norm.KindTrades},
		Env:     norm.Envelope{V: 1, Type: norm.TypeTrade, Src: "binance", Seq: seq},
	}
}

func (f *fakeFeed) Resync(context.Context) error { f.resyncs.Add(1); return nil }
func (f *fakeFeed) Close() error                 { return nil }

// recorder is a Sink that remembers everything it saw.
type recorder struct {
	mu   sync.Mutex
	msgs []RawMsg
}

func (r *recorder) Publish(_ context.Context, m RawMsg) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	return nil
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.msgs)
}

func newTestManager(f Feed, s Sink, reg *health.Registry) *Manager {
	return NewManager(f, s, reg, slog.New(slog.DiscardHandler))
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal(msg)
}

func TestManager_PublishesAndGoesLive(t *testing.T) {
	feed, sink, reg := newFakeFeed(), &recorder{}, health.NewRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go newTestManager(feed, sink, reg).Run(ctx)
	waitFor(t, time.Second, func() bool { return feed.connects.Load() >= 1 }, "never connected")
	feed.send(1)
	feed.send(2)
	waitFor(t, time.Second, func() bool { return sink.count() == 2 }, "sink never saw messages")
	if got := reg.Get("fake.ws"); got != health.StateLive {
		t.Errorf("state = %s, want LIVE", got)
	}
}

func TestManager_StalenessForcesReconnect(t *testing.T) {
	feed, sink, reg := newFakeFeed(), &recorder{}, health.NewRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go newTestManager(feed, sink, reg).Run(ctx)
	waitFor(t, time.Second, func() bool { return feed.connects.Load() >= 1 }, "never connected")
	// Send nothing: 3×5ms of silence must trigger a reconnect (§5.2).
	waitFor(t, time.Second, func() bool { return feed.connects.Load() >= 2 },
		"staleness did not force a reconnect")
}

func TestManager_SequenceGapTriggersResync(t *testing.T) {
	feed, sink, reg := newFakeFeed(), &recorder{}, health.NewRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go newTestManager(feed, sink, reg).Run(ctx)
	waitFor(t, time.Second, func() bool { return feed.connects.Load() >= 1 }, "never connected")
	feed.send(1)
	feed.send(2)
	feed.send(5) // gap: 3,4 lost (§5.3)
	waitFor(t, time.Second, func() bool { return feed.resyncs.Load() >= 1 },
		"gap did not trigger resync")
}

func TestManager_ConnectFailureBacksOffAndMarksStale(t *testing.T) {
	feed, sink, reg := newFakeFeed(), &recorder{}, health.NewRegistry()
	feed.connectErr = errors.New("refused")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go newTestManager(feed, sink, reg).Run(ctx)
	waitFor(t, time.Second, func() bool { return feed.connects.Load() >= 2 },
		"no reconnect attempts after failure")
	if got := reg.Get("fake.ws"); got != health.StateStale && got != health.StateDown {
		t.Errorf("state = %s, want STALE (or DOWN)", got)
	}
	// Never gives up (§5.1): attempts keep coming.
	waitFor(t, 2*time.Second, func() bool { return feed.connects.Load() >= 3 },
		"manager gave up reconnecting")
}
