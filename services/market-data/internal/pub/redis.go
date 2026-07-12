// Package pub publishes normalized messages to Redis per architecture.md §4:
// PUBLISH for lossy md.* market data, XADD (capped streams) for durable evt.*
// events, and the health:{service} heartbeat (§5.5).
package pub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/health"
	"github.com/terminal/market-data/internal/norm"
)

// StreamMaxLen caps evt.* streams (MAXLEN ~, architecture.md §4.1).
const StreamMaxLen = 100_000

// Redis implements conn.Sink over a Redis client.
type Redis struct {
	client redis.UniversalClient
}

var _ conn.Sink = (*Redis)(nil)

func NewRedis(client redis.UniversalClient) *Redis {
	return &Redis{client: client}
}

// Publish sends one md.* message (fire-and-forget pub/sub — consumers that
// fall behind resync from snapshots, §5.4).
func (r *Redis) Publish(ctx context.Context, msg conn.RawMsg) error {
	payload, err := json.Marshal(msg.Env)
	if err != nil {
		return fmt.Errorf("pub: marshal envelope: %w", err)
	}
	if err := r.client.Publish(ctx, msg.Channel.String(), payload).Err(); err != nil {
		return fmt.Errorf("pub: publish %s: %w", msg.Channel.String(), err)
	}
	return nil
}

// AppendEvent adds one durable event to an evt.* stream with at-least-once
// semantics (consumer groups ack on the other side).
func (r *Redis) AppendEvent(ctx context.Context, stream string, env norm.Envelope) error {
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("pub: marshal event: %w", err)
	}
	err = r.client.XAdd(ctx, &redis.XAddArgs{
		Stream: stream,
		MaxLen: StreamMaxLen,
		Approx: true,
		Values: map[string]any{"env": payload},
	}).Err()
	if err != nil {
		return fmt.Errorf("pub: xadd %s: %w", stream, err)
	}
	return nil
}

// Heartbeat writes health:{service} every interval with a TTL of 3× interval
// (§5.5: 5s beat, 15s TTL) until ctx ends. Blocking; run in a goroutine.
func (r *Redis) Heartbeat(ctx context.Context, service string, reg *health.Registry, interval time.Duration) {
	key := "health:" + service
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			rep := reg.Report(time.Now())
			payload, err := json.Marshal(rep)
			if err != nil {
				continue // marshal of our own struct failing is unreachable
			}
			_ = r.client.Set(ctx, key, payload, 3*interval).Err()
		case <-ctx.Done():
			return
		}
	}
}
