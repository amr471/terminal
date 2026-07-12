package conn

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/terminal/market-data/internal/health"
)

// Manager runs one Feed with the full §5 contract: reconnect with jittered
// backoff, heartbeat staleness, sequence-gap resync, and health-state
// reporting. One manager per feed; managers are independent so a dead feed
// degrades one panel, never the terminal (§5.6).
type Manager struct {
	feed    Feed
	sink    Sink
	states  *health.Registry
	clock   Clock
	backoff *Backoff
	log     *slog.Logger

	// downAfter marks the feed DOWN when reconnects keep failing (§5.5).
	downAfter time.Duration

	mu      sync.Mutex
	lastSeq uint64
}

// NewManager wires a feed to a sink with production defaults.
func NewManager(feed Feed, sink Sink, states *health.Registry, log *slog.Logger) *Manager {
	return &Manager{
		feed:      feed,
		sink:      sink,
		states:    states,
		clock:     RealClock{},
		backoff:   NewBackoff(),
		log:       log.With("feed", feed.Name()),
		downAfter: 5 * time.Minute,
	}
}

// WithClock swaps the clock (tests). Returns m for chaining.
func (m *Manager) WithClock(c Clock) *Manager { m.clock = c; return m }

// Run drives the connect → consume → reconnect loop until ctx is cancelled.
// Never gives up permanently (§5.1).
func (m *Manager) Run(ctx context.Context) {
	firstFailure := time.Time{}
	for {
		if ctx.Err() != nil {
			return
		}
		if err := m.feed.Connect(ctx); err != nil {
			if firstFailure.IsZero() {
				firstFailure = m.clock.Now()
			}
			state := health.StateStale
			if m.clock.Now().Sub(firstFailure) >= m.downAfter {
				state = health.StateDown
			}
			m.states.Set(m.feed.Name(), state)
			delay := m.backoff.Next()
			m.log.Warn("connect failed; backing off",
				"err", err, "delay", delay, "attempt", m.backoff.Attempt(), "code", "MD-1003")
			select {
			case <-m.clock.After(delay):
			case <-ctx.Done():
				return
			}
			continue
		}

		firstFailure = time.Time{}
		m.states.Set(m.feed.Name(), health.StateLive)
		m.consume(ctx)
		// consume returned: connection is gone. Loop reconnects.
		m.states.Set(m.feed.Name(), health.StateStale)
		_ = m.feed.Close()
	}
}

// consume forwards messages until the feed closes its channel, the heartbeat
// says STALE (§5.2), or ctx ends. A healthy minute resets the backoff (§5.1).
func (m *Manager) consume(ctx context.Context) {
	staleAfter := 3 * m.feed.ExpectedInterval()
	healthyReset := m.clock.After(time.Minute)
	lastMsg := m.clock.Now()

	for {
		select {
		case msg, ok := <-m.feed.Messages():
			if !ok {
				m.log.Warn("feed channel closed; reconnecting")
				return
			}
			lastMsg = m.clock.Now()
			m.checkSeq(ctx, msg.Env.Seq)
			if err := m.sink.Publish(ctx, msg); err != nil {
				m.log.Error("publish failed", "err", err, "channel", msg.Channel.String())
			}

		case <-m.clock.After(staleAfter):
			if m.clock.Now().Sub(lastMsg) >= staleAfter {
				m.states.Set(m.feed.Name(), health.StateStale)
				m.log.Warn("feed stale; forcing reconnect",
					"silent_for", m.clock.Now().Sub(lastMsg), "code", "MD-1002")
				return
			}

		case <-healthyReset:
			m.backoff.Reset()

		case <-ctx.Done():
			return
		}
	}
}

// checkSeq detects gaps and regressions (§5.3/§5.4): a regression means the
// publisher restarted; a gap means lost messages. Both trigger Resync.
func (m *Manager) checkSeq(ctx context.Context, seq uint64) {
	m.mu.Lock()
	last := m.lastSeq
	m.lastSeq = seq
	m.mu.Unlock()

	if last == 0 || seq == last+1 || seq == 0 {
		return
	}
	m.log.Warn("sequence anomaly; resyncing", "last", last, "got", seq, "code", "MD-1001")
	m.states.Set(m.feed.Name(), health.StateDegraded)
	if err := m.feed.Resync(ctx); err != nil && !errors.Is(err, context.Canceled) {
		m.log.Error("resync failed", "err", err)
		return
	}
	m.states.Set(m.feed.Name(), health.StateLive)
}
