// Package norm defines the normalized message contract — the Go mirror of
// @terminal/types (packages/types/src/market.ts). architecture.md §4.2 is the
// spec; the TS package is the source of truth. Field names and JSON shapes
// must match exactly; goldens in envelope_test.go enforce it.
package norm

// Dec is a string-encoded decimal (architecture.md §4.3). Prices, quantities,
// and rates travel as strings end to end; parse to a decimal type only inside
// computation kernels. Never float64 on the wire.
type Dec = string

// MessageType matches the TS MESSAGE_TYPES union.
type MessageType string

const (
	TypeTrade   MessageType = "trade"
	TypeBook    MessageType = "book"
	TypeCandle  MessageType = "candle"
	TypeFunding MessageType = "funding"
	TypeOI      MessageType = "oi"
	TypeLiq     MessageType = "liq"
	TypeTicker  MessageType = "ticker"
)

// Envelope is the wire format for every md.* and evt.* message.
type Envelope struct {
	V    int         `json:"v"`             // envelope version, always 1
	Type MessageType `json:"type"`          // payload type, matches channel suffix
	Src  string      `json:"src"`           // origin feed, e.g. "binance"
	Sym  string      `json:"sym,omitempty"` // normalized lowercase symbol
	TS   int64       `json:"ts"`            // event time at exchange, ms epoch
	RTS  int64       `json:"rts"`           // receive time on our side, ms epoch
	Seq  uint64      `json:"seq"`           // per-publisher per-channel sequence
	Data any         `json:"data"`
}

// Trade mirrors TS TradePayload.
type Trade struct {
	Price Dec    `json:"price"`
	Qty   Dec    `json:"qty"`
	Side  string `json:"side"` // "buy" | "sell"
	ID    string `json:"id,omitempty"`
}

// Book mirrors TS BookPayload. Levels are [price, qty]; qty "0" deletes.
type Book struct {
	Bids     [][2]Dec `json:"bids"`
	Asks     [][2]Dec `json:"asks"`
	Snapshot bool     `json:"snapshot,omitempty"`
	BookSeq  uint64   `json:"bookSeq,omitempty"` // exchange seq for gap detection (§5.3)
}

// Candle mirrors TS CandlePayload.
type Candle struct {
	TF          string `json:"tf"`
	Open        Dec    `json:"open"`
	High        Dec    `json:"high"`
	Low         Dec    `json:"low"`
	Close       Dec    `json:"close"`
	Volume      Dec    `json:"volume"`
	QuoteVolume Dec    `json:"quoteVolume,omitempty"`
	TradeCount  int    `json:"tradeCount,omitempty"`
	Final       bool   `json:"final,omitempty"`
}

// Funding mirrors TS FundingPayload.
type Funding struct {
	Rate          Dec   `json:"rate"`
	NextFundingTS int64 `json:"nextFundingTs,omitempty"`
}

// OI mirrors TS OiPayload.
type OI struct {
	OpenInterest    Dec `json:"openInterest"`
	OpenInterestUSD Dec `json:"openInterestUsd,omitempty"`
}

// Liq mirrors TS LiqPayload.
type Liq struct {
	Side   string `json:"side"` // position side liquidated: "long" | "short"
	Price  Dec    `json:"price"`
	Qty    Dec    `json:"qty"`
	QtyUSD Dec    `json:"qtyUsd,omitempty"`
}
