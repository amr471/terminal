package exchange

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

// TickerRow is one venue-wide 24h ticker reading, already normalized.
type TickerRow struct {
	Symbol string // normalized (norm.NormalizeSymbol form)
	TS     int64  // ms epoch; 0 means "use receive time"
	Ticker norm.Ticker
}

// TickerParser turns one venue's all-tickers REST response into normalized
// rows. Implementations live in the venue package (that's where the wire quirks
// belong); this package never learns a venue's JSON shape.
type TickerParser func(body []byte) ([]TickerRow, error)

// RESTTickerFeed polls a venue's "24h stats for every instrument" REST endpoint
// and emits norm.KindTicker (P1.5e).
//
// Why REST rather than websocket for most venues: only some publish an
// all-market ticker stream (Binance's one-frame-covers-everything
// `!ticker@arr`; Bybit already carries the fields on a topic we subscribe).
// The rest offer 24h stats only per-symbol over ws, which would (a) cost one
// stream per symbol against a connection budget that already forced sharding,
// and (b) still only cover the capped symbol set — while the whole point of
// this feed is universe-wide coverage, because the screener's `volume_24h > 0`
// filter hides any instrument without a volume. One REST call per interval
// returns every instrument at once, costs no stream budget, and is the same
// shape as the OI pollers already in this codebase.
//
// It implements conn.Feed so it gets the identical backoff/staleness/health
// treatment as a real socket (ADR-006): "connected" here means the poll loop is
// running. Use it as a venue-wide singleton via VenueFeeder, never per shard —
// it already covers every symbol, so a per-shard copy would be pure duplication.
type RESTTickerFeed struct {
	venue      string
	name       string
	url        string
	parse      TickerParser
	interval   time.Duration
	httpClient *http.Client
	log        *slog.Logger

	msgs   chan conn.RawMsg
	seq    atomic.Uint64
	cancel context.CancelFunc
}

var _ conn.Feed = (*RESTTickerFeed)(nil)

// DefaultTickerPollInterval: 24h stats move slowly and feed a screener column,
// not a scalping signal. 15s is fresh enough to feel live while staying far
// under every venue's public rate limit for a single whole-market request.
const DefaultTickerPollInterval = 15 * time.Second

// NewRESTTickerFeed builds the poller. `name` is the feed id used in health
// reports and logs, e.g. "okx.ticker.rest".
func NewRESTTickerFeed(venue, name, url string, parse TickerParser, log *slog.Logger) *RESTTickerFeed {
	return &RESTTickerFeed{
		venue:      venue,
		name:       name,
		url:        url,
		parse:      parse,
		interval:   DefaultTickerPollInterval,
		httpClient: &http.Client{Timeout: 15 * time.Second},
		log:        log.With("feed", name),
	}
}

// WithInterval overrides the poll cadence (tests, or a venue with a tighter
// rate limit). Returns f for chaining.
func (f *RESTTickerFeed) WithInterval(d time.Duration) *RESTTickerFeed {
	if d > 0 {
		f.interval = d
	}
	return f
}

// WithHTTPClient swaps the client (tests point this at an httptest server).
func (f *RESTTickerFeed) WithHTTPClient(c *http.Client) *RESTTickerFeed {
	if c != nil {
		f.httpClient = c
	}
	return f
}

func (f *RESTTickerFeed) Name() string                    { return f.name }
func (f *RESTTickerFeed) ExpectedInterval() time.Duration { return f.interval }

// Connect polls once immediately — so an unreachable endpoint fails fast into
// Manager's backoff exactly like a failed ws dial — then starts the loop.
func (f *RESTTickerFeed) Connect(ctx context.Context) error {
	// Generous buffer: one poll emits a message PER INSTRUMENT, and a venue can
	// list a few thousand.
	f.msgs = make(chan conn.RawMsg, 8192)
	if err := f.pollOnce(ctx); err != nil {
		close(f.msgs)
		f.msgs = nil
		return fmt.Errorf("%s: initial poll: %w", f.name, err)
	}
	loopCtx, cancel := context.WithCancel(ctx)
	f.cancel = cancel
	go f.loop(loopCtx)
	return nil
}

func (f *RESTTickerFeed) loop(ctx context.Context) {
	defer close(f.msgs)
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := f.pollOnce(ctx); err != nil {
				f.log.Warn("ticker poll cycle failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (f *RESTTickerFeed) pollOnce(ctx context.Context) error {
	body, err := fetchBytes(ctx, f.httpClient, f.url)
	if err != nil {
		return err
	}
	rows, err := f.parse(body)
	if err != nil {
		return fmt.Errorf("parse tickers: %w", err)
	}
	now := time.Now().UnixMilli()
	for _, r := range rows {
		if r.Symbol == "" {
			continue
		}
		ts := r.TS
		if ts == 0 {
			ts = now
		}
		f.emit(r.Symbol, ts, r.Ticker)
	}
	return nil
}

func (f *RESTTickerFeed) emit(symbol string, ts int64, tk norm.Ticker) {
	ch := norm.Channel{Exchange: f.venue, Symbol: symbol, Kind: norm.KindTicker}
	// Seq only assigned on actual enqueue — same ordering fix as every other
	// feed's emit (a drop must not consume a sequence number, or Manager
	// misreads it as a real gap and triggers a needless Resync).
	if len(f.msgs) >= cap(f.msgs) {
		// Rate-limited: a poll is thousands of symbols, so an unthrottled warn
		// would itself become the bottleneck.
		if f.seq.Load()%10000 == 0 {
			f.log.Warn("dropped ticker; consumer too slow", "channel", ch.String())
		}
		return
	}
	f.msgs <- conn.RawMsg{Channel: ch, Env: norm.Envelope{
		V: 1, Type: norm.TypeTicker, Src: f.venue, Sym: symbol,
		TS: ts, RTS: time.Now().UnixMilli(), Seq: f.seq.Add(1), Data: tk,
	}}
}

func (f *RESTTickerFeed) Messages() <-chan conn.RawMsg { return f.msgs }

// Resync is a no-op: every poll is already a complete fresh snapshot of every
// instrument, so there is no incremental state to repair.
func (f *RESTTickerFeed) Resync(context.Context) error { return nil }

func (f *RESTTickerFeed) Close() error {
	if f.cancel != nil {
		f.cancel()
	}
	return nil
}
