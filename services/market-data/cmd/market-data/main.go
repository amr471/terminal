// market-data — Go hot path: exchange WS ingestion, normalization, Redis
// fan-out (architecture.md §2/§3). F0.6 skeleton: resilient framework wired
// end to end, no live exchange feeds yet (those land with P1 data work).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/terminal/market-data/internal/health"
	"github.com/terminal/market-data/internal/pub"
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

	states := health.NewRegistry()
	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() { _ = client.Close() }()
	publisher := pub.NewRedis(client)

	// Health heartbeat: 5s beat, 15s TTL (§5.5).
	go publisher.Heartbeat(ctx, service, states, 5*time.Second)

	// Feeds are registered here as they land (P1): one conn.Manager per feed,
	// each running in its own goroutine:
	//   mgr := conn.NewManager(feed, publisher, states, log)
	//   go mgr.Run(ctx)

	srv := &http.Server{
		Addr:              httpAddr,
		Handler:           health.Handler(states),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("health endpoints up", "addr", httpAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
