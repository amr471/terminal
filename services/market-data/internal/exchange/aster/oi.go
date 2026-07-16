package aster

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

// OIFeed REST-polls open interest per symbol — Aster, like Binance, has no
// open-interest websocket channel. Mirrors binance.OIFeed. If Aster's
// /fapi/v1/openInterest path differs or is absent (VERIFY, package doc),
// fetches log and OI stays null; the poll loop itself keeps running (ADR-006).
type OIFeed struct {
	symbols    []string
	restURL    string
	interval   time.Duration
	httpClient *http.Client
	log        *slog.Logger

	msgs   chan conn.RawMsg
	seq    atomic.Uint64
	cancel context.CancelFunc
}

var _ conn.Feed = (*OIFeed)(nil)

const pollInterval = 30 * time.Second

func NewOIFeed(symbols []string, log *slog.Logger) *OIFeed {
	return &OIFeed{
		symbols:    symbols,
		restURL:    restBase,
		interval:   pollInterval,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		log:        log.With("feed", "aster.oi.rest"),
	}
}

func (f *OIFeed) Name() string                    { return "aster.oi.rest" }
func (f *OIFeed) ExpectedInterval() time.Duration { return f.interval }

func (f *OIFeed) Connect(ctx context.Context) error {
	f.msgs = make(chan conn.RawMsg, len(f.symbols)*2)
	if err := f.pollOnce(ctx); err != nil {
		return fmt.Errorf("aster.oi.rest: initial poll: %w", err)
	}
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.loop(loopCtx)
	return nil
}

func (f *OIFeed) loop(ctx context.Context) {
	defer close(f.msgs)
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := f.pollOnce(ctx); err != nil {
				f.log.Warn("poll cycle failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *OIFeed) pollOnce(ctx context.Context) error {
	var firstErr error
	for _, symbol := range f.symbols {
		oi, ts, err := f.fetchOI(ctx, symbol)
		if err != nil {
			f.log.Warn("fetch open interest failed", "symbol", symbol, "err", err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		f.emit(symbol, ts, oi)
	}
	return firstErr
}

type openInterestResp struct {
	Symbol       string `json:"symbol"`
	OpenInterest string `json:"openInterest"`
	Time         int64  `json:"time"`
}

func (f *OIFeed) fetchOI(ctx context.Context, symbol string) (norm.OI, int64, error) {
	url := fmt.Sprintf("%s/fapi/v1/openInterest?symbol=%s", f.restURL, strings.ToUpper(symbol))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return norm.OI{}, 0, fmt.Errorf("build request: %w", err)
	}
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return norm.OI{}, 0, fmt.Errorf("do request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return norm.OI{}, 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	var body openInterestResp
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return norm.OI{}, 0, fmt.Errorf("decode: %w", err)
	}
	ts := body.Time
	if ts == 0 {
		ts = time.Now().UnixMilli()
	}
	return norm.OI{OpenInterest: body.OpenInterest}, ts, nil
}

func (f *OIFeed) emit(symbol string, ts int64, oi norm.OI) {
	ch := norm.Channel{Exchange: exchangeName, Symbol: symbol, Kind: norm.KindOI}
	env := norm.Envelope{
		V: 1, Type: norm.TypeOI, Src: exchangeName, Sym: symbol,
		TS: ts, RTS: time.Now().UnixMilli(), Seq: f.seq.Add(1), Data: oi,
	}
	select {
	case f.msgs <- conn.RawMsg{Channel: ch, Env: env}:
	default:
		f.log.Warn("dropped OI reading; consumer too slow", "symbol", symbol)
	}
}

func (f *OIFeed) Messages() <-chan conn.RawMsg { return f.msgs }

// Resync is a no-op: each poll is a full fresh reading, nothing to repair.
func (f *OIFeed) Resync(ctx context.Context) error { return nil }

func (f *OIFeed) Close() error {
	if f.cancel != nil {
		f.cancel()
	}
	return nil
}
