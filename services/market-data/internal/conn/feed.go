package conn

import (
	"context"
	"time"

	"github.com/terminal/market-data/internal/norm"
)

// RawMsg is one upstream message after exchange-specific decoding but before
// publication: the envelope plus the channel it belongs on.
type RawMsg struct {
	Channel norm.Channel
	Env     norm.Envelope
}

// Feed is one upstream connection (an exchange websocket, a REST poller).
// Implementations own their Messages channel and close it when the
// connection dies — that is the manager's disconnect signal.
type Feed interface {
	// Name identifies the feed in health reports, e.g. "binance.ws".
	Name() string
	// ExpectedInterval is the longest normal silence; 3× this marks the feed
	// STALE (§5.2).
	ExpectedInterval() time.Duration
	// Connect establishes the connection and starts producing on Messages.
	// Called again after each disconnect (the manager handles backoff).
	Connect(ctx context.Context) error
	// Messages yields decoded messages. Closed by the feed on disconnect.
	Messages() <-chan RawMsg
	// Resync rebuilds state after a sequence gap (§5.3): drop the local book,
	// fetch a snapshot, resume. Called by the manager when it detects a gap.
	Resync(ctx context.Context) error
	// Close releases the connection; Connect may be called again afterwards.
	Close() error
}

// Sink receives normalized messages from the manager (the Redis publisher in
// production; a recorder in tests).
type Sink interface {
	Publish(ctx context.Context, msg RawMsg) error
}
