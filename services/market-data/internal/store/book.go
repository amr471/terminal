package store

import (
	"sort"
	"strings"

	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/norm"
)

// localBook mirrors the L2 contract from architecture.md §4.2/norm.Book:
// price levels are [price,qty], qty "0" deletes, snapshot=true replaces the
// whole side. This is a downstream consumer's view for the cache:book:*
// snapshot only — NOT the authoritative book (that's the exchange feed's own
// gap-tracked state used for Resync, §5.3); a missed apply here just means a
// slightly stale first-paint snapshot, corrected by the next message.
//
// Price levels are keyed by canonicalPriceKey, not the raw wire string —
// found via a real crossed-book bug (2026-07-17: cache:book:bybit:btcusdt
// showed a stale ask sitting below the tightly-clustered real asks, i.e.
// best bid > best ask). A venue can serialize the same numeric price with a
// different number of trailing fractional zeros across messages (e.g. a
// snapshot sending "62849.90" and a later delta deleting that level as
// "62849.9"); keying the map by the raw string treats those as two
// different levels, so the delete silently misses its target and the
// original level is orphaned forever instead of being cleaned up. The
// original doc comment above ("a missed apply just means a slightly stale
// snapshot, corrected by the next message") holds for a missed *update* but
// not for a missed *deletion* — a stale level that's never deleted stays
// wrong indefinitely, not just until the next message.
type localBook struct {
	bids map[string]decimal.Decimal // canonical price key -> qty
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
		key, ok := canonicalPriceKey(priceStr)
		if !ok {
			continue // malformed price; same drop-rather-than-corrupt stance as above
		}
		if qty.IsZero() {
			delete(side, key)
			continue
		}
		side[key] = qty
	}
}

// canonicalPriceKey validates priceStr as a decimal and strips formatting
// that doesn't change its numeric value (leading zeros, a redundant "+",
// trailing fractional zeros) so the same price always maps to the same key
// regardless of which of a venue's messages — snapshot or delta — it came
// from. Pure string manipulation rather than round-tripping through
// decimal.Decimal, to stay inside CLAUDE.md's string-decimal convention (no
// float parsing anywhere on this path) and because shopspring/decimal
// preserves the exponent it was parsed with, so it would NOT itself collapse
// "62849.90" and "62849.9" to the same String() output.
func canonicalPriceKey(priceStr string) (string, bool) {
	if _, err := decimal.NewFromString(priceStr); err != nil {
		return "", false
	}
	s := priceStr
	neg := false
	switch {
	case strings.HasPrefix(s, "-"):
		neg = true
		s = s[1:]
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	}
	intPart, fracPart, hasFrac := strings.Cut(s, ".")
	if hasFrac {
		fracPart = strings.TrimRight(fracPart, "0")
	}
	intPart = strings.TrimLeft(intPart, "0")
	if intPart == "" {
		intPart = "0"
	}
	out := intPart
	if fracPart != "" {
		out += "." + fracPart
	}
	if neg && out != "0" {
		out = "-" + out
	}
	return out, true
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
