// Package store persists normalized market data: final candle buckets, OI,
// and funding to the hypertables (architecture.md §2, ADR-005: svc_market_data
// is the sole writer), and maintains instrument_state — the screener's
// deterministic working set (schema.md §4) — from live ticks. Order books are
// NOT persisted here (schema.md §5: "books live in Redis cache:book:*, Postgres
// only gets derived series"); this package writes cache:ticker/cache:book
// instead of a hypertable for that data.
package store

import (
	"math"

	"github.com/shopspring/decimal"
)

// percentChange returns (current-prior)/prior as a fraction (e.g. -0.052 for
// -5.2%, matching instrument_state.change_* convention in the hypertables
// migration). Returns nil when prior is unknown or zero (can't divide, and a
// missing baseline is a legitimate "not enough history yet" state — not zero).
func percentChange(current, prior decimal.Decimal) *decimal.Decimal {
	if prior.IsZero() {
		return nil
	}
	out := current.Sub(prior).Div(prior)
	return &out
}

// volatility24h is the population standard deviation of consecutive log
// returns over the given closes (oldest first), matching the common realized-
// volatility estimator. Needs at least 2 closes; returns nil otherwise (not
// enough history — expected for the first ~24h after a symbol starts
// ingesting, not a bug).
func volatility24h(closesOldestFirst []decimal.Decimal) *decimal.Decimal {
	if len(closesOldestFirst) < 2 {
		return nil
	}
	returns := make([]float64, 0, len(closesOldestFirst)-1)
	for i := 1; i < len(closesOldestFirst); i++ {
		prev, cur := closesOldestFirst[i-1], closesOldestFirst[i]
		if prev.IsZero() || prev.IsNegative() || cur.IsNegative() {
			continue // a non-positive close is bad data; skip rather than NaN the whole series
		}
		prevF, _ := prev.Float64()
		curF, _ := cur.Float64()
		returns = append(returns, math.Log(curF/prevF))
	}
	if len(returns) < 2 {
		return nil
	}
	mean := 0.0
	for _, r := range returns {
		mean += r
	}
	mean /= float64(len(returns))
	variance := 0.0
	for _, r := range returns {
		d := r - mean
		variance += d * d
	}
	variance /= float64(len(returns))
	sd := decimal.NewFromFloat(math.Sqrt(variance))
	return &sd
}

// spreadFraction returns (ask-bid)/mid, the convention instrument_state.spread
// uses elsewhere in this codebase (a dimensionless fraction, not a raw price
// difference, so symbols at very different price levels stay comparable in
// the screener). Returns nil when either side of the book is empty.
func spreadFraction(bestBid, bestAsk *decimal.Decimal) *decimal.Decimal {
	if bestBid == nil || bestAsk == nil {
		return nil
	}
	mid := bestBid.Add(*bestAsk).Div(decimal.NewFromInt(2))
	if mid.IsZero() {
		return nil
	}
	out := bestAsk.Sub(*bestBid).Div(mid)
	return &out
}
