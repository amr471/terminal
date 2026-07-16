// market-data — Go hot path: exchange WS ingestion, normalization, Redis
// fan-out (architecture.md §2/§3). F0.6 built the resilient framework
// feed-less; P1.5a wires in the three exchanges (Binance/Bybit/OKX) plus
// hypertable persistence + instrument_state maintenance. See
// docs/market-data-feeds.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/exchange/aster"
	"github.com/terminal/market-data/internal/exchange/binance"
	"github.com/terminal/market-data/internal/exchange/bingx"
	"github.com/terminal/market-data/internal/exchange/bybit"
	"github.com/terminal/market-data/internal/exchange/hyperliquid"
	"github.com/terminal/market-data/internal/exchange/kucoin"
	"github.com/terminal/market-data/internal/exchange/mexc"
	"github.com/terminal/market-data/internal/exchange/okx"
	"github.com/terminal/market-data/internal/health"
	"github.com/terminal/market-data/internal/pub"
	"github.com/terminal/market-data/internal/store"
)

const service = "market-data"

func main() {
	// Structured JSON logs from day 1 (§5.7). No secrets, ever.
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	redisAddr := envOr("REDIS_ADDR", "localhost:6379")
	httpAddr := envOr("HTTP_ADDR", ":8081")
	dbURL := envOr("DATABASE_URL_MARKET_DATA", "postgres://svc_market_data:dev_local_only@localhost:5432/terminal")
	symbols := parseSymbols(envOr("MARKET_DATA_SYMBOLS", "btcusdt,ethusdt,solusdt"))

	states := health.NewRegistry()
	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() { _ = client.Close() }()
	publisher := pub.NewRedis(client)

	// Postgres is not fatal to start without — a feed that can't persist
	// still publishes md.* live to the browser (ADR-006 degradation stance,
	// §5.6: a dead dependency degrades, it doesn't take the whole service
	// down). NewPostgres itself only builds a pool (lazy connect), so this
	// never blocks startup; failures show up as write errors in the logs
	// and via /readyz once wired to a real health check.
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	pg, err := store.NewPostgres(connectCtx, dbURL)
	cancel()
	if err != nil {
		log.Error("postgres pool init failed; continuing with Redis-only fan-out", "err", err)
	} else {
		defer pg.Close()
	}

	sink := conn.Sink(publisher)
	if pg != nil {
		agg := store.NewAggregator(pg, client, log)
		go agg.Run(ctx)
		sink = store.NewFanoutSink(publisher, agg, log)
	} else {
		log.Warn("running without instrument_state/hypertable persistence (no postgres)")
	}

	// Health heartbeat: 5s beat, 15s TTL (§5.5).
	go publisher.Heartbeat(ctx, service, states, 5*time.Second)

	// The venue registry (P1.5b). Adding a venue is one line here plus its
	// own internal/exchange/<venue> package — see docs/exchange-adapters.md.
	// Assembled here, not inside package exchange, to avoid an import cycle
	// (venue packages import exchange for the Adapter interface).
	registry := exchange.NewRegistry(
		binance.Adapter(),
		bybit.Adapter(),
		okx.Adapter(),
		hyperliquid.Adapter(),
		kucoin.Adapter(),
		aster.Adapter(),
		mexc.Adapter(),
		bingx.Adapter(),
	)

	registerFeeds(ctx, registry, symbols, sink, states, log)

	srv := &http.Server{
		Addr:              httpAddr,
		Handler:           health.Handler(states),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("health endpoints up", "addr", httpAddr, "symbols", symbols)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	_ = srv.Shutdown(shutdownCtx)
}

// registerFeeds starts one conn.Manager per feed, each its own goroutine,
// per the F0.6 skeleton's own comment on how feeds plug in. The per-venue
// topology (which feeds, book-per-symbol scoping, unlisted-symbol skips) now
// lives behind each Adapter.Feeds (P1.5b) — this loop is venue-agnostic.
// Book feeds are one per (exchange,symbol) — see each exchange package's doc
// for why (Manager.checkSeq needs per-symbol scoping); trades/candles/
// funding(+OI) are multiplexed per exchange across every symbol.
func registerFeeds(ctx context.Context, registry *exchange.Registry, symbols []string, sink conn.Sink, states *health.Registry, log *slog.Logger) {
	for _, feed := range registry.Feeds(symbols, log) {
		mgr := conn.NewManager(feed, sink, states, log)
		go mgr.Run(ctx)
	}
}

func parseSymbols(csv string) []string {
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
