package store

import (
	"fmt"
	"time"

	"github.com/shopspring/decimal"
)

// InstrumentState mirrors the instrument_state table (market-data/migrations/
// 0001_hypertables.sql) — the screener's deterministic working set (P1.6),
// overwritten in place, never appended to. Fields are pointers so a NULL
// column round-trips as nil rather than a false zero.
type InstrumentState struct {
	Exchange      string
	Symbol        string
	AssetClass    string // always "crypto" for the P1.5a exchanges; P1B.3 adds "stock"
	Price         *decimal.Decimal
	Change1h      *decimal.Decimal
	Change24h     *decimal.Decimal
	Change7d      *decimal.Decimal
	Volume24h     *decimal.Decimal
	MarketCap     *decimal.Decimal // always nil for MVP — no circulating-supply source wired yet (deliberate deferral, see docs/market-data-feeds.md)
	OpenInterest  *decimal.Decimal
	FundingRate   *decimal.Decimal
	Volatility24h *decimal.Decimal
	Spread        *decimal.Decimal
	UpdatedAt     time.Time
}

// key identifies one (exchange,symbol) pair, matching instrument_state's PK.
func key(exchange, symbol string) string { return exchange + "|" + symbol }

// tickerCacheKey / bookCacheKey match architecture.md §4.1's cache/state key
// contract exactly: cache:ticker:{exchange}:{symbol} (TTL 10s) and
// cache:book:{exchange}:{symbol} (no TTL, overwritten) — the gateway's
// GET /md/snapshot/:exchange/:symbol (docs/gateway-ws.md) reads both verbatim.
func tickerCacheKey(exchange, symbol string) string {
	return fmt.Sprintf("cache:ticker:%s:%s", exchange, symbol)
}

func bookCacheKey(exchange, symbol string) string {
	return fmt.Sprintf("cache:book:%s:%s", exchange, symbol)
}

// tickerCache is the JSON shape written to cache:ticker:*. The gateway
// forwards it byte-for-byte (docs/gateway-ws.md: "never reinterprets"), so
// this shape is this package's own contract, not @terminal/types' — kept
// intentionally small (first-paint price context only, not a full
// instrument_state row).
type tickerCache struct {
	Price     string `json:"price"`
	TS        int64  `json:"ts"`
	FundingRt string `json:"fundingRate,omitempty"`
	OI        string `json:"openInterest,omitempty"`
}

// bookCache is the JSON shape written to cache:book:*: a full local L2
// mirror (top N levels) plus best-bid/ask convenience fields, so a panel can
// paint immediately without replaying deltas itself.
type bookCache struct {
	Bids    [][2]string `json:"bids"`
	Asks    [][2]string `json:"asks"`
	TS      int64       `json:"ts"`
	BookSeq uint64      `json:"bookSeq,omitempty"`
}

// bookLevels is the maintained topN cutoff for cache:book — enough for any
// depth-of-market panel without unbounded growth in a busy book.
const bookLevels = 50
