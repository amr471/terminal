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
