package bybit

import (
	"io"
	"log/slog"
	"testing"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/norm"
)

func newBookTestFeed() *WSFeed {
	return &WSFeed{
		log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		books: map[string]*bookSeq{},
		msgs:  make(chan conn.RawMsg, 8),
	}
}

func drainBook(f *WSFeed) []norm.Book {
	var out []norm.Book
	for {
		select {
		case m := <-f.msgs:
			if b, ok := m.Env.Data.(norm.Book); ok {
				out = append(out, b)
			}
		default:
			return out
		}
	}
}

func TestOnBookSnapshotThenContiguousDeltas(t *testing.T) {
	f := newBookTestFeed()
	f.onBook("snapshot", orderbookMsg{Symbol: "BTCUSDT", U: 100, Bids: [][2]string{{"99", "1"}}, Asks: [][2]string{{"101", "2"}}})
	f.onBook("delta", orderbookMsg{Symbol: "BTCUSDT", U: 101, Bids: [][2]string{{"99", "0"}}})
	f.onBook("delta", orderbookMsg{Symbol: "BTCUSDT", U: 102, Asks: [][2]string{{"102", "3"}}})

	got := drainBook(f)
	if len(got) != 3 {
		t.Fatalf("emitted %d book msgs, want 3", len(got))
	}
	if !got[0].Snapshot || got[1].Snapshot || got[2].Snapshot {
		t.Fatalf("snapshot flags = %v/%v/%v, want true/false/false", got[0].Snapshot, got[1].Snapshot, got[2].Snapshot)
	}
	if f.books["btcusdt"].lastU != 102 {
		t.Fatalf("lastU = %d, want 102", f.books["btcusdt"].lastU)
	}
}

func TestOnBookGapDropsUntilResync(t *testing.T) {
	f := newBookTestFeed()
	f.onBook("snapshot", orderbookMsg{Symbol: "BTCUSDT", U: 100})
	// Gap: expected u=101, got u=105 → drop + mark unsynced (resubscribe is a
	// no-op here since f.conn is nil).
	f.onBook("delta", orderbookMsg{Symbol: "BTCUSDT", U: 105})
	// A later delta while unsynced is also dropped (no snapshot replayed yet).
	f.onBook("delta", orderbookMsg{Symbol: "BTCUSDT", U: 106})

	got := drainBook(f)
	if len(got) != 1 || !got[0].Snapshot {
		t.Fatalf("emitted %d msgs (want 1 snapshot only): %+v", len(got), got)
	}
	if f.books["btcusdt"].synced {
		t.Fatalf("should be unsynced after a gap")
	}
}
