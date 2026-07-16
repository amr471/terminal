package store

import (
	"sort"

	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/norm"
)

// localBook mirrors the L2 contract from architecture.md §4.2/norm.Book:
// price levels are [price,qty], qty "0" deletes, snapshot=true replaces the
// whole side. This is a downstream consumer's view for the cache:book:*
// snapshot only — NOT the authoritative book (that's the exchange feed's own
// gap-tracked state used for Resync, §5.3); a missed apply here just means a
// slightly stale first-paint snapshot, corrected by the next message.
type localBook struct {
	bids map[string]decimal.Decimal // price string -> qty
	asks map[string]decimal.Decimal
}

func newLocalBook() *localBook {
	return &localBook{bids: map[string]decimal.Decimal{}, asks: map[string]decimal.Decimal{}}
}

func (b *localBook) apply(book norm.Book) {
	if book.Snapshot {
		b.bids = map[string]decimal.Decimal{}
		b.asks = map[string]decimal.Decimal{}
	}
	applySide(b.bids, book.Bids)
	applySide(b.asks, book.Asks)
}

func applySide(side map[string]decimal.Decimal, levels [][2]norm.Dec) {
	for _, lvl := range levels {
		priceStr, qtyStr := lvl[0], lvl[1]
		qty, err := decimal.NewFromString(qtyStr)
		if err != nil {
			continue // malformed level from a hostile feed; drop rather than corrupt the book
		}
		if qty.IsZero() {
			delete(side, priceStr)
			continue
		}
		price, err := decimal.NewFromString(priceStr)
		if err != nil {
			continue
		}
		_ = price // priceStr is the map key; parsed only to validate it's numeric
		side[priceStr] = qty
	}
}

// bestBid / bestAsk return the top of book, or nil if that side is empty.
func (b *localBook) bestBid() *decimal.Decimal { return topOf(b.bids, true) }
func (b *localBook) bestAsk() *decimal.Decimal { return topOf(b.asks, false) }

func topOf(side map[string]decimal.Decimal, highest bool) *decimal.Decimal {
	if len(side) == 0 {
		return nil
	}
	var best *decimal.Decimal
	for priceStr := range side {
		price, err := decimal.NewFromString(priceStr)
		if err != nil {
			continue
		}
		if best == nil || (highest && price.GreaterThan(*best)) || (!highest && price.LessThan(*best)) {
			p := price
			best = &p
		}
	}
	return best
}

// snapshot renders up to bookLevels of each side, best price first, for
// cache:book:* serialization.
func (b *localBook) snapshot() (bids, asks [][2]string) {
	bids = sortedLevels(b.bids, true)
	asks = sortedLevels(b.asks, false)
	return bids, asks
}

func sortedLevels(side map[string]decimal.Decimal, highestFirst bool) [][2]string {
	type lvl struct {
		price decimal.Decimal
		str   string
		qty   decimal.Decimal
	}
	levels := make([]lvl, 0, len(side))
	for priceStr, qty := range side {
		price, err := decimal.NewFromString(priceStr)
		if err != nil {
			continue
		}
		levels = append(levels, lvl{price: price, str: priceStr, qty: qty})
	}
	sort.Slice(levels, func(i, j int) bool {
		if highestFirst {
			return levels[i].price.GreaterThan(levels[j].price)
		}
		return levels[i].price.LessThan(levels[j].price)
	})
	if len(levels) > bookLevels {
		levels = levels[:bookLevels]
	}
	out := make([][2]string, len(levels))
	for i, l := range levels {
		out[i] = [2]string{l.str, l.qty.String()}
	}
	return out
}
