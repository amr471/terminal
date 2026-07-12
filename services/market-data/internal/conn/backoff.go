// Package conn implements the feed-resilience contract from architecture.md §5:
// reconnection with jittered exponential backoff, heartbeat staleness, and
// health-state tracking. Every feed consumer goes through this package —
// third-party feeds are assumed hostile (CLAUDE.md §2, ADR-006).
package conn

import (
	"math/rand/v2"
	"time"
)

// Backoff computes reconnect delays: full jitter over an exponential curve,
// delay = rand(0, min(cap, base·2^attempt)) — architecture.md §5.1.
type Backoff struct {
	Base time.Duration // default 1s
	Cap  time.Duration // default 60s
	// rand returns a float64 in [0,1); injectable for tests.
	rand    func() float64
	attempt int
}

// NewBackoff returns the §5.1 policy: base 1s, cap 60s.
func NewBackoff() *Backoff {
	return &Backoff{Base: time.Second, Cap: 60 * time.Second, rand: rand.Float64}
}

// Next returns the delay before the next reconnect attempt and advances the
// attempt counter. Never tight-loops: the minimum is 0 but the ceiling grows.
func (b *Backoff) Next() time.Duration {
	ceil := b.Base << b.attempt // base·2^attempt
	if ceil > b.Cap || ceil <= 0 {
		ceil = b.Cap
	}
	if b.attempt < 30 { // avoid pointless shift growth
		b.attempt++
	}
	return time.Duration(b.rand() * float64(ceil))
}

// Reset zeroes the attempt counter — call after 60s of healthy connection
// (§5.1) so a feed that dies later starts from short delays again.
func (b *Backoff) Reset() { b.attempt = 0 }

// Attempt reports how many delays have been handed out since the last reset.
func (b *Backoff) Attempt() int { return b.attempt }
