package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// testPostgres connects using DATABASE_URL_MARKET_DATA (falling back to the
// local-dev default in .env.example) and skips gracefully if unreachable —
// this sandbox has neither Docker nor sudo, so real execution happens on
// John's machine or CI, same skip-if-unreachable convention the TS test
// suites already use (docs/gateway-ws.md, docs/auth.md).
func testPostgres(t *testing.T) *Postgres {
	t.Helper()
	connString := os.Getenv("DATABASE_URL_MARKET_DATA")
	if connString == "" {
		connString = "postgres://svc_market_data:dev_local_only@localhost:5432/terminal"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pg, err := NewPostgres(ctx, connString)
	if err != nil {
		t.Skipf("skip: could not construct postgres pool: %v", err)
	}
	if err := pg.Ping(ctx); err != nil {
		pg.Close()
		t.Skipf("skip: postgres not reachable at %s: %v", connString, err)
	}
	t.Cleanup(pg.Close)
	return pg
}

func TestPostgres_UpsertInstrumentState_RoundTrips(t *testing.T) {
	pg := testPostgres(t)
	ctx := context.Background()

	price := dec("64123.50")
	change := dec("-0.014")
	s := InstrumentState{
		Exchange: "binance", Symbol: "p15atestbtcusdt", AssetClass: "crypto",
		Price: &price, Change24h: &change, UpdatedAt: time.Now().UTC(),
	}
	if err := pg.UpsertInstrumentState(ctx, s); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}
	// Idempotent re-upsert (ON CONFLICT DO UPDATE) must not error.
	if err := pg.UpsertInstrumentState(ctx, s); err != nil {
		t.Fatalf("second upsert failed: %v", err)
	}
}

func TestPostgres_CandleInsertAndPriorClose(t *testing.T) {
	pg := testPostgres(t)
	ctx := context.Background()
	symbol := "p15atestethusdt"
	now := time.Now().UTC().Truncate(time.Hour)

	row := CandleRow{
		Exchange: "binance", Symbol: symbol, TF: "1h", TS: now.Add(-2 * time.Hour),
		Open: dec("100"), High: dec("110"), Low: dec("95"), Close: dec("105"), Volume: dec("10"),
	}
	if err := pg.InsertCandle(ctx, row); err != nil {
		t.Fatalf("insert candle failed: %v", err)
	}

	got, err := pg.PriorClose(ctx, "binance", symbol, "1h", now)
	if err != nil {
		t.Fatalf("prior close failed: %v", err)
	}
	if got == nil || !got.Equal(dec("105")) {
		t.Fatalf("prior close = %v, want 105", got)
	}
}

func TestPostgres_PriorClose_NoHistoryReturnsNil(t *testing.T) {
	pg := testPostgres(t)
	ctx := context.Background()
	got, err := pg.PriorClose(ctx, "binance", "p15a-nonexistent-symbol", "1h", time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("got %v, want nil for a symbol with no candle history", got)
	}
}

func TestPostgres_FundingAndOIInsert(t *testing.T) {
	pg := testPostgres(t)
	ctx := context.Background()
	symbol := "p15atestsolusdt"
	now := time.Now().UTC()

	if err := pg.InsertFunding(ctx, FundingRow{
		Exchange: "bybit", Symbol: symbol, TS: now, Rate: dec("0.0001"),
	}); err != nil {
		t.Fatalf("insert funding failed: %v", err)
	}
	usd := dec("1000000")
	if err := pg.InsertOI(ctx, OIRow{
		Exchange: "bybit", Symbol: symbol, TS: now, OpenInterest: dec("5000"), OpenInterestUSD: &usd,
	}); err != nil {
		t.Fatalf("insert oi failed: %v", err)
	}
}

func TestPostgres_Volume24h_SumsQuoteVolumeOverTrailing24h(t *testing.T) {
	pg := testPostgres(t)
	ctx := context.Background()
	symbol := "p15atestvolusdt"
	now := time.Now().UTC().Truncate(time.Hour)

	for i, qv := range []string{"1000", "2000"} {
		q := dec(qv)
		row := CandleRow{
			Exchange: "binance", Symbol: symbol, TF: "1h", TS: now.Add(time.Duration(-i-1) * time.Hour),
			Open: dec("1"), High: dec("1"), Low: dec("1"), Close: dec("1"), Volume: dec("1"), QuoteVolume: &q,
		}
		if err := pg.InsertCandle(ctx, row); err != nil {
			t.Fatalf("insert candle failed: %v", err)
		}
	}

	got, err := pg.Volume24h(ctx, "binance", symbol)
	if err != nil {
		t.Fatalf("volume24h failed: %v", err)
	}
	if got == nil || !got.Equal(dec("3000")) {
		t.Fatalf("volume24h = %v, want 3000", got)
	}
}
