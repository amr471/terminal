package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// writer is what the Aggregator needs from persistent storage. Narrow on
// purpose so tests can substitute a fake instead of a real Postgres
// (internal/store/aggregator_test.go) — only postgres_test.go needs a real
// database, following this repo's skip-if-unreachable convention.
type writer interface {
	UpsertInstrumentState(ctx context.Context, s InstrumentState) error
	InsertCandle(ctx context.Context, c CandleRow) error
	InsertFunding(ctx context.Context, f FundingRow) error
	InsertOI(ctx context.Context, o OIRow) error
	// PriorClose returns the most recent tf-candle close at or before
	// `before`, or nil if none exists yet (not enough history — legitimate
	// for a symbol that just started ingesting).
	PriorClose(ctx context.Context, exchange, symbol, tf string, before time.Time) (*decimal.Decimal, error)
	// RecentCloses returns tf-candle closes strictly after `since`, oldest
	// first.
	RecentCloses(ctx context.Context, exchange, symbol, tf string, since time.Time) ([]decimal.Decimal, error)
	// Volume24h sums 1h-candle quote volume (falling back to base volume)
	// over the trailing 24h.
	Volume24h(ctx context.Context, exchange, symbol string) (*decimal.Decimal, error)
}

// CandleRow/FundingRow/OIRow are the hypertable insert shapes — deliberately
// separate from norm.Candle/Funding/OI (wire payloads) so a decimal-parse
// failure surfaces once, at the feed boundary, not on every consumer.
type CandleRow struct {
	Exchange, Symbol, TF           string
	TS                             time.Time
	Open, High, Low, Close, Volume decimal.Decimal
	QuoteVolume                    *decimal.Decimal
	TradeCount                     *int
}

type FundingRow struct {
	Exchange, Symbol string
	TS               time.Time
	Rate             decimal.Decimal
	NextFundingTS    *time.Time
}

type OIRow struct {
	Exchange, Symbol string
	TS               time.Time
	OpenInterest     decimal.Decimal
	OpenInterestUSD  *decimal.Decimal
}

// Postgres implements writer over svc_market_data's own hypertables +
// instrument_state (ADR-005 single-writer). Never touches any other
// service's tables.
type Postgres struct {
	pool *pgxpool.Pool
}

var _ writer = (*Postgres)(nil)

// NewPostgres dials DATABASE_URL_MARKET_DATA. Callers must Close() on
// shutdown.
func NewPostgres(ctx context.Context, connString string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, connString)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

// Ping checks connectivity for /readyz.
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

func (p *Postgres) UpsertInstrumentState(ctx context.Context, s InstrumentState) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO instrument_state
			(exchange, symbol, asset_class, price, change_1h, change_24h, change_7d,
			 volume_24h, market_cap, open_interest, funding_rate, volatility_24h, spread, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (exchange, symbol) DO UPDATE SET
			asset_class    = EXCLUDED.asset_class,
			price          = EXCLUDED.price,
			change_1h      = EXCLUDED.change_1h,
			change_24h     = EXCLUDED.change_24h,
			change_7d      = EXCLUDED.change_7d,
			volume_24h     = EXCLUDED.volume_24h,
			market_cap     = EXCLUDED.market_cap,
			open_interest  = EXCLUDED.open_interest,
			funding_rate   = EXCLUDED.funding_rate,
			volatility_24h = EXCLUDED.volatility_24h,
			spread         = EXCLUDED.spread,
			updated_at     = EXCLUDED.updated_at`,
		s.Exchange, s.Symbol, s.AssetClass, decStrOrNil(s.Price), decStrOrNil(s.Change1h), decStrOrNil(s.Change24h),
		decStrOrNil(s.Change7d), decStrOrNil(s.Volume24h), decStrOrNil(s.MarketCap), decStrOrNil(s.OpenInterest),
		decStrOrNil(s.FundingRate), decStrOrNil(s.Volatility24h), decStrOrNil(s.Spread), s.UpdatedAt)
	if err != nil {
		return fmt.Errorf("store: upsert instrument_state %s/%s: %w", s.Exchange, s.Symbol, err)
	}
	return nil
}

func (p *Postgres) InsertCandle(ctx context.Context, c CandleRow) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO candles (exchange, symbol, tf, ts, open, high, low, close, volume, quote_volume, trade_count)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (exchange, symbol, tf, ts) DO UPDATE SET
			open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
			volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume, trade_count = EXCLUDED.trade_count`,
		c.Exchange, c.Symbol, c.TF, c.TS, c.Open.String(), c.High.String(), c.Low.String(), c.Close.String(),
		c.Volume.String(), decStrOrNil(c.QuoteVolume), c.TradeCount)
	if err != nil {
		return fmt.Errorf("store: insert candle %s/%s/%s: %w", c.Exchange, c.Symbol, c.TF, err)
	}
	return nil
}

func (p *Postgres) InsertFunding(ctx context.Context, f FundingRow) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO funding (exchange, symbol, ts, rate, next_funding_ts)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (exchange, symbol, ts) DO UPDATE SET
			rate = EXCLUDED.rate, next_funding_ts = EXCLUDED.next_funding_ts`,
		f.Exchange, f.Symbol, f.TS, f.Rate.String(), f.NextFundingTS)
	if err != nil {
		return fmt.Errorf("store: insert funding %s/%s: %w", f.Exchange, f.Symbol, err)
	}
	return nil
}

func (p *Postgres) InsertOI(ctx context.Context, o OIRow) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO oi (exchange, symbol, ts, open_interest, open_interest_usd)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (exchange, symbol, ts) DO UPDATE SET
			open_interest = EXCLUDED.open_interest, open_interest_usd = EXCLUDED.open_interest_usd`,
		o.Exchange, o.Symbol, o.TS, o.OpenInterest.String(), decStrOrNil(o.OpenInterestUSD))
	if err != nil {
		return fmt.Errorf("store: insert oi %s/%s: %w", o.Exchange, o.Symbol, err)
	}
	return nil
}

// Numeric columns are scanned as text and parsed with decimal.NewFromString
// rather than into decimal.Decimal directly — sidesteps any ambiguity in how
// a driver-level NULL round-trips through shopspring/decimal's own
// sql.Scanner (which treats NULL as zero, not "unknown"), matching this
// repo's "string-encoded decimals end to end" rule (architecture.md §4.3)
// one layer further than the wire — all the way to the DB round trip.
func (p *Postgres) PriorClose(ctx context.Context, exchange, symbol, tf string, before time.Time) (*decimal.Decimal, error) {
	var s *string
	err := p.pool.QueryRow(ctx, `
		SELECT close::text FROM candles
		WHERE exchange = $1 AND symbol = $2 AND tf = $3 AND ts <= $4
		ORDER BY ts DESC LIMIT 1`, exchange, symbol, tf, before).Scan(&s)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("store: prior close %s/%s/%s: %w", exchange, symbol, tf, err)
	}
	return parseDecPtr(s)
}

func (p *Postgres) RecentCloses(ctx context.Context, exchange, symbol, tf string, since time.Time) ([]decimal.Decimal, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT close::text FROM candles
		WHERE exchange = $1 AND symbol = $2 AND tf = $3 AND ts > $4
		ORDER BY ts ASC`, exchange, symbol, tf, since)
	if err != nil {
		return nil, fmt.Errorf("store: recent closes %s/%s/%s: %w", exchange, symbol, tf, err)
	}
	defer rows.Close()
	var out []decimal.Decimal
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("store: scan close: %w", err)
		}
		d, err := decimal.NewFromString(s)
		if err != nil {
			return nil, fmt.Errorf("store: parse close %q: %w", s, err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) Volume24h(ctx context.Context, exchange, symbol string) (*decimal.Decimal, error) {
	var s *string
	err := p.pool.QueryRow(ctx, `
		SELECT SUM(COALESCE(quote_volume, volume))::text FROM candles
		WHERE exchange = $1 AND symbol = $2 AND tf = '1h' AND ts > now() - interval '24 hours'`,
		exchange, symbol).Scan(&s)
	if err != nil {
		return nil, fmt.Errorf("store: volume24h %s/%s: %w", exchange, symbol, err)
	}
	return parseDecPtr(s)
}

func parseDecPtr(s *string) (*decimal.Decimal, error) {
	if s == nil {
		return nil, nil
	}
	d, err := decimal.NewFromString(*s)
	if err != nil {
		return nil, fmt.Errorf("store: parse decimal %q: %w", *s, err)
	}
	return &d, nil
}

func decStrOrNil(d *decimal.Decimal) any {
	if d == nil {
		return nil
	}
	return d.String()
}
