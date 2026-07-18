package store

import (
	"strconv"
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func TestLocalBook_SnapshotThenDelta(t *testing.T) {
	b := newLocalBook()
	b.apply(norm.Book{
		Snapshot: true,
		Bids:     [][2]norm.Dec{{"100", "1"}, {"99", "2"}},
		Asks:     [][2]norm.Dec{{"101", "1"}, {"102", "2"}},
	})

	if got := b.bestBid(); got == nil || !got.Equal(dec("100")) {
		t.Fatalf("bestBid = %v, want 100", got)
	}
	if got := b.bestAsk(); got == nil || !got.Equal(dec("101")) {
		t.Fatalf("bestAsk = %v, want 101", got)
	}

	// Delta: qty "0" deletes the best bid level; a new level appears above it.
	b.apply(norm.Book{Bids: [][2]norm.Dec{{"100", "0"}, {"100.5", "1"}}})
	if got := b.bestBid(); got == nil || !got.Equal(dec("100.5")) {
		t.Fatalf("bestBid after delta = %v, want 100.5", got)
	}
}

func TestLocalBook_SnapshotReplacesRatherThanMerges(t *testing.T) {
	b := newLocalBook()
	b.apply(norm.Book{Snapshot: true, Bids: [][2]norm.Dec{{"100", "1"}}, Asks: [][2]norm.Dec{{"101", "1"}}})
	// A fresh snapshot (e.g. post-resync) must wipe stale levels, not merge.
	b.apply(norm.Book{Snapshot: true, Bids: [][2]norm.Dec{{"50", "1"}}, Asks: [][2]norm.Dec{{"51", "1"}}})

	if got := b.bestBid(); got == nil || !got.Equal(dec("50")) {
		t.Fatalf("bestBid = %v, want 50 (stale 100 level should be gone)", got)
	}
}

func TestLocalBook_EmptySideReturnsNil(t *testing.T) {
	b := newLocalBook()
	if b.bestBid() != nil || b.bestAsk() != nil {
		t.Fatal("expected nil best bid/ask on an empty book")
	}
}

// Real-world bug (2026-07-17): cache:book:bybit:btcusdt showed a crossed
// book (best bid > best ask) — a raw redis-cli check found an orphaned ask
// level sitting below the real, tightly-clustered ask prices. Root cause:
// applySide keyed price levels by the raw wire string, so a delta deleting
// a level with a differently-formatted trailing-zero price than the one
// that inserted it (e.g. snapshot sends "62849.90", delta deletes
// "62849.9") missed the map entry entirely, orphaning it forever instead of
// just until the next message.
func TestLocalBook_DeleteMatchesDifferentTrailingZeroFormat(t *testing.T) {
	b := newLocalBook()
	b.apply(norm.Book{
		Snapshot: true,
		Asks:     [][2]norm.Dec{{"62849.90", "1"}, {"62854.90", "1"}},
	})
	if got := b.bestAsk(); got == nil || !got.Equal(dec("62849.90")) {
		t.Fatalf("bestAsk = %v, want 62849.90", got)
	}

	b.apply(norm.Book{Asks: [][2]norm.Dec{{"62849.9", "0"}}})

	if got := b.bestAsk(); got == nil || !got.Equal(dec("62854.90")) {
		t.Fatalf("bestAsk after delete = %v, want 62854.90 (62849.9x level should be gone)", got)
	}
}

func TestCanonicalPriceKey(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"62849.90", "62849.9", true},
		{"62849.9", "62849.9", true},
		{"100", "100", true},
		{"0100", "100", true},
		{"-0.500", "-0.5", true},
		{"0.0", "0", true},
		{"-0", "0", true},
		{"+5.20", "5.2", true},
		{"abc", "", false},
	}
	for _, c := range cases {
		got, ok := canonicalPriceKey(c.in)
		if ok != c.ok {
			t.Fatalf("canonicalPriceKey(%q) ok = %v, want %v", c.in, ok, c.ok)
		}
		if ok && got != c.want {
			t.Fatalf("canonicalPriceKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestLocalBook_SnapshotOrdersBestFirstAndCapsDepth(t *testing.T) {
	b := newLocalBook()
	levels := make([][2]norm.Dec, 0, bookLevels+5)
	for i := 0; i < bookLevels+5; i++ {
		levels = append(levels, [2]norm.Dec{strconv.Itoa(100 + i), "1"})
	}
	b.apply(norm.Book{Snapshot: true, Bids: levels})

	bids, _ := b.snapshot()
	if len(bids) != bookLevels {
		t.Fatalf("len(bids) = %d, want %d (capped)", len(bids), bookLevels)
	}
	// Best bid (highest price) first.
	first := dec(bids[0][0])
	second := dec(bids[1][0])
	if !first.GreaterThan(second) {
		t.Fatalf("bids not sorted best-first: %v then %v", first, second)
	}
}
