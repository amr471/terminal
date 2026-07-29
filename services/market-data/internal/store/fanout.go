package store

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

// redisPublisher is the subset of pub.Redis that FanoutSink needs — kept
// narrow so tests don't need a real Redis-backed pub.Redis, only something
// that implements conn.Sink.
type redisPublisher interface {
	Publish(ctx context.Context, msg conn.RawMsg) error
}

// FanoutSink is the conn.Sink every feed's Manager publishes through: it
// preserves the existing Redis md.* pub/sub fan-out (pub.Redis, unchanged
// since F0.6/P1.2) and additionally routes the same message into the
// Aggregator for hypertable persistence + instrument_state maintenance
// (P1.5a's other two responsibilities, per architecture.md §2's table:
// market-data publishes md.* AND writes candles/oi/funding).
//
// Both paths run for every message; a Postgres/Redis-cache failure in the
// Aggregator side is logged, never blocks or drops the md.* publish (the
// live tick to subscribed browsers is the higher-priority path — ADR-004,
// md.* is lossy-tolerant by design, but a browser watching live shouldn't
// stall because a hypertable write is slow).
type FanoutSink struct {
	redis redisPublisher
	agg   *Aggregator
	log   *slog.Logger
}

var _ conn.Sink = (*FanoutSink)(nil)

func NewFanoutSink(redis redisPublisher, agg *Aggregator, log *slog.Logger) *FanoutSink {
	return &FanoutSink{redis: redis, agg: agg, log: log}
}

func (f *FanoutSink) Publish(ctx context.Context, msg conn.RawMsg) error {
	if err := f.redis.Publish(ctx, msg); err != nil {
		return fmt.Errorf("fanout: redis publish: %w", err)
	}
	f.route(ctx, msg)
	return nil
}

func (f *FanoutSink) route(ctx context.Context, msg conn.RawMsg) {
	exchange, symbol := msg.Channel.Exchange, msg.Channel.Symbol
	switch data := msg.Env.Data.(type) {
	case norm.Trade:
		f.agg.OnTrade(ctx, exchange, symbol, msg.Env, data)
	case norm.Book:
		f.agg.OnBook(ctx, exchange, symbol, msg.Env, data)
	case norm.Candle:
		f.agg.OnCandle(ctx, exchange, symbol, msg.Env, data)
	case norm.Funding:
		f.agg.OnFunding(ctx, exchange, symbol, msg.Env, data)
	case norm.OI:
		f.agg.OnOI(ctx, exchange, symbol, msg.Env, data)
	case norm.Ticker:
		f.agg.OnTicker(ctx, exchange, symbol, msg.Env, data)
	default:
		f.log.Warn("fanout: unroutable envelope data type", "type", msg.Env.Type, "channel", msg.Channel.String())
	}
}
