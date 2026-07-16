package kucoin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/terminal/market-data/internal/norm"
)

// flexStr unmarshals from a JSON string OR number into a string decimal —
// KuCoin mixes the two (book levels and funding rate as numbers, price as a
// string), and we keep everything as string decimals (architecture.md §4.3).
type flexStr string

func (s *flexStr) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*s = ""
		return nil
	}
	if b[0] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		*s = flexStr(str)
		return nil
	}
	*s = flexStr(b)
	return nil
}

// envelope is KuCoin's ws frame. Only type=="message" carries a topic+data;
// welcome/ack/pong/error frames are ignored by classify.
type envelope struct {
	Type    string          `json:"type"`
	Topic   string          `json:"topic"`
	Subject string          `json:"subject"`
	Data    json.RawMessage `json:"data"`
}

// classify splits a message frame into its channel path, the topic's symbol
// suffix (everything after ":", e.g. "XBTUSDTM" or "XBTUSDTM_1hour"), the
// subject, and data. ok=false for non-message frames.
func classify(raw []byte) (path, suffix, subject string, data json.RawMessage, ok bool, err error) {
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", "", "", nil, false, fmt.Errorf("kucoin: classify: %w", err)
	}
	if e.Type != "message" {
		return "", "", "", nil, false, nil // welcome / ack / pong / error
	}
	p, s, found := strings.Cut(e.Topic, ":")
	if !found {
		return "", "", "", nil, false, fmt.Errorf("kucoin: topic without symbol: %q", e.Topic)
	}
	return p, s, e.Subject, e.Data, true, nil
}

type tradeOut struct {
	Symbol string
	TS     int64
	Trade  norm.Trade
}

type execMsg struct {
	Symbol  string  `json:"symbol"`
	Side    string  `json:"side"` // "buy" | "sell" (taker side)
	Size    flexStr `json:"size"` // CONTRACTS, not base units (package doc)
	Price   flexStr `json:"price"`
	TradeID string  `json:"tradeId"`
	TS      int64   `json:"ts"` // nanoseconds
}

func decodeTrade(data json.RawMessage) (tradeOut, error) {
	var m execMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return tradeOut{}, fmt.Errorf("kucoin: decode execution: %w", err)
	}
	return tradeOut{
		Symbol: symbolFromWire(m.Symbol), TS: nsToMs(m.TS),
		Trade: norm.Trade{Price: string(m.Price), Qty: string(m.Size), Side: m.Side, ID: m.TradeID},
	}, nil
}

type bookOut struct {
	Symbol string
	TS     int64
	Book   norm.Book
}

type depthMsg struct {
	Asks      [][]flexStr `json:"asks"`
	Bids      [][]flexStr `json:"bids"`
	TS        int64       `json:"ts"`        // nanoseconds on futures depth
	Timestamp int64       `json:"timestamp"` // some payloads use ms here
}

// decodeBook turns a level2Depth50 full snapshot into a norm.Book
// (Snapshot=true). suffix is the topic symbol (e.g. "XBTUSDTM").
func decodeBook(suffix string, data json.RawMessage) (bookOut, error) {
	var m depthMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return bookOut{}, fmt.Errorf("kucoin: decode level2Depth50: %w", err)
	}
	ts := m.Timestamp
	if ts == 0 {
		ts = nsToMs(m.TS)
	}
	return bookOut{
		Symbol: symbolFromWire(suffix), TS: ts,
		Book: norm.Book{Bids: levelsToDec(m.Bids), Asks: levelsToDec(m.Asks), Snapshot: true},
	}, nil
}

func levelsToDec(levels [][]flexStr) [][2]norm.Dec {
	out := make([][2]norm.Dec, 0, len(levels))
	for _, l := range levels {
		if len(l) < 2 {
			continue
		}
		out = append(out, [2]norm.Dec{string(l[0]), string(l[1])})
	}
	return out
}

type candleOut struct {
	Symbol string
	TS     int64
	Candle norm.Candle
}

type candleMsg struct {
	Symbol  string    `json:"symbol"`
	Candles []flexStr `json:"candles"` // [time, open, close, high, low, volume, turnover]
}

// decodeCandle decodes a limitCandle frame. suffix is "{wire}_{granularity}"
// (e.g. "XBTUSDTM_1hour"). KuCoin's array order is [time, open, CLOSE, high,
// low, volume, turnover] — note open/close before high/low. Final is left
// false; the WSFeed sets it via candleTracker rollover.
func decodeCandle(suffix string, data json.RawMessage) (candleOut, error) {
	wire, gran, found := strings.Cut(suffix, "_")
	if !found {
		return candleOut{}, fmt.Errorf("kucoin: candle topic without granularity: %q", suffix)
	}
	tf, ok := tfForGranularity[gran]
	if !ok {
		return candleOut{}, fmt.Errorf("kucoin: unknown candle granularity %q", gran)
	}
	var m candleMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return candleOut{}, fmt.Errorf("kucoin: decode limitCandle: %w", err)
	}
	if len(m.Candles) < 6 {
		return candleOut{}, fmt.Errorf("kucoin: candle row has %d fields, want >=6", len(m.Candles))
	}
	c := norm.Candle{
		TF:     tf,
		Open:   string(m.Candles[1]),
		Close:  string(m.Candles[2]),
		High:   string(m.Candles[3]),
		Low:    string(m.Candles[4]),
		Volume: string(m.Candles[5]),
	}
	if len(m.Candles) >= 7 {
		c.QuoteVolume = string(m.Candles[6])
	}
	return candleOut{Symbol: symbolFromWire(wire), TS: bucketMs(string(m.Candles[0])), Candle: c}, nil
}

type fundingMsg struct {
	FundingRate flexStr `json:"fundingRate"`
	Timestamp   int64   `json:"timestamp"` // ms
}

// decodeFunding handles the contract/instrument channel's "funding.rate"
// subject. suffix is the topic symbol.
func decodeFunding(suffix string, data json.RawMessage) (symbol string, ts int64, funding norm.Funding, err error) {
	var m fundingMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return "", 0, norm.Funding{}, fmt.Errorf("kucoin: decode funding.rate: %w", err)
	}
	return symbolFromWire(suffix), m.Timestamp, norm.Funding{Rate: string(m.FundingRate)}, nil
}

// candleTracker is identical in spirit to the HyperLiquid one: KuCoin's
// limitCandle has no closed-bucket flag, so a new bucket's open time finalizes
// the previous bucket.
type candleTracker struct {
	last map[string]candleOut
}

func newCandleTracker() *candleTracker { return &candleTracker{last: map[string]candleOut{}} }

func (t *candleTracker) observe(c candleOut) (finalized candleOut, hasFinalized bool, live candleOut) {
	key := c.Symbol + "|" + c.Candle.TF
	if prev, ok := t.last[key]; ok && c.TS > prev.TS {
		finalized = prev
		finalized.Candle.Final = true
		hasFinalized = true
	}
	t.last[key] = c
	live = c
	live.Candle.Final = false
	return finalized, hasFinalized, live
}
