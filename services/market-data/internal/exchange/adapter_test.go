package exchange

import (
	"context"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/terminal/market-data/internal/conn"
)

// stubFeed is a minimal conn.Feed for counting/identity in registry tests —
// none of its methods are exercised here (the registry only moves Feeds
// around, never runs them).
type stubFeed struct{ name string }

func (s stubFeed) Name() string                    { return s.name }
func (s stubFeed) ExpectedInterval() time.Duration { return time.Second }
func (s stubFeed) Connect(context.Context) error   { return nil }
func (s stubFeed) Messages() <-chan conn.RawMsg    { return nil }
func (s stubFeed) Resync(context.Context) error    { return nil }
func (s stubFeed) Close() error                    { return nil }

// fakeAdapter is a test-only Adapter whose Feeds returns one stubFeed per
// symbol it "lists" (every symbol except those in unlisted).
type fakeAdapter struct {
	name     string
	kinds    []string
	limits   Limits
	unlisted map[string]bool
}

func (a fakeAdapter) Name() string { return a.name }
func (a fakeAdapter) WireSymbol(symbol string) (string, bool) {
	if a.unlisted[symbol] {
		return "", false
	}
	return a.name + ":" + symbol, true
}
func (a fakeAdapter) ProvidedKinds() []string                       { return a.kinds }
func (a fakeAdapter) Limits() Limits                                { return a.limits }
func (a fakeAdapter) StreamsPerSymbol() int                         { return 1 }
func (a fakeAdapter) Instruments(context.Context) ([]string, error) { return nil, nil }
func (a fakeAdapter) Feeds(symbols []string, _ *slog.Logger) []conn.Feed {
	var out []conn.Feed
	for _, s := range symbols {
		if a.unlisted[s] {
			continue
		}
		out = append(out, stubFeed{name: a.name + "." + s})
	}
	return out
}

func TestNewRegistryPreservesOrderAndLookup(t *testing.T) {
	a := fakeAdapter{name: "alpha"}
	b := fakeAdapter{name: "bravo"}
	c := fakeAdapter{name: "charlie"}
	r := NewRegistry(a, b, c)

	gotOrder := make([]string, 0, 3)
	for _, ad := range r.Adapters() {
		gotOrder = append(gotOrder, ad.Name())
	}
	if want := []string{"alpha", "bravo", "charlie"}; !reflect.DeepEqual(gotOrder, want) {
		t.Fatalf("Adapters() order = %v, want %v", gotOrder, want)
	}

	if ad, ok := r.ByName("bravo"); !ok || ad.Name() != "bravo" {
		t.Fatalf("ByName(bravo) = %v, %v", ad, ok)
	}
	if _, ok := r.ByName("delta"); ok {
		t.Fatalf("ByName(delta) should be absent")
	}
}

func TestNewRegistryPanicsOnDuplicateName(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatalf("expected panic on duplicate adapter name")
		}
	}()
	NewRegistry(fakeAdapter{name: "dup"}, fakeAdapter{name: "dup"})
}

func TestRegistryFeedsFlattensAndSkipsUnlisted(t *testing.T) {
	symbols := []string{"btcusdt", "ethusdt", "solusdt"}
	full := fakeAdapter{name: "full"}
	// "partial" doesn't list solusdt — Feeds should skip it (OKX-style).
	partial := fakeAdapter{name: "partial", unlisted: map[string]bool{"solusdt": true}}
	r := NewRegistry(full, partial)

	feeds := r.Feeds(symbols, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// full: 3 feeds, partial: 2 (solusdt skipped) = 5.
	if len(feeds) != 5 {
		t.Fatalf("Feeds count = %d, want 5", len(feeds))
	}
	got := make([]string, len(feeds))
	for i, f := range feeds {
		got[i] = f.Name()
	}
	want := []string{"full.btcusdt", "full.ethusdt", "full.solusdt", "partial.btcusdt", "partial.ethusdt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Feeds names = %v, want %v", got, want)
	}
}

func TestWireSymbolUnlisted(t *testing.T) {
	a := fakeAdapter{name: "v", unlisted: map[string]bool{"xrpusdt": true}}
	if _, ok := a.WireSymbol("xrpusdt"); ok {
		t.Fatalf("xrpusdt should be unlisted")
	}
	if w, ok := a.WireSymbol("btcusdt"); !ok || w != "v:btcusdt" {
		t.Fatalf("WireSymbol(btcusdt) = %q, %v", w, ok)
	}
}
