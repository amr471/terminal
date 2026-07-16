package binance

import (
	"encoding/json"
	"fmt"

	"github.com/terminal/market-data/internal/norm"
)

// classify peeks the "e" discriminator every futures market stream message
// carries. Decoded via a raw key map rather than a single-field struct
// deliberately: encoding/json's case-insensitive fallback matching would
// otherwise collide "E" (event time, present on every message) with a
// struct field tagged only "e" (lowercase) — Go tries the exact-case match
// first, but "E" has no exact match in a one-field struct, so it falls back
// to matching "e" case-insensitively and fails trying to assign a number to
// a string field. A map's keys are never case-folded, so "e" and "E" stay
// distinct. (The per-message decode structs like aggTradeMsg don't hit this
// — they declare both "e" and "E" fields explicitly, so both keys get exact
// matches and neither falls back.)
func classify(raw []byte) (string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return "", fmt.Errorf("binance: classify: %w", err)
	}
	eventRaw, ok := top["e"]
	if !ok {
		return "", fmt.Errorf("binance: no event type in message: %s", truncate(raw))
	}
	var event string
	if err := json.Unmarshal(eventRaw, &event); err != nil {
		return "", fmt.Errorf("binance: classify event type: %w", err)
	}
	return event, nil
}

type aggTradeMsg struct {
	Event  string `json:"e"`
	EventT int64  `json:"E"`
	Symbol string `json:"s"`
	Price  string `json:"p"`
	Qty    string `json:"q"`
	Maker  bool   `json:"m"` // true if the buyer is the market maker (i.e. the aggressor sold)
	ID     int64  `json:"a"`
}

// decodeAggTrade returns the normalized symbol, event-time ms, and trade
// payload for one Binance aggTrade message.
func decodeAggTrade(raw []byte) (symbol string, ts int64, trade norm.Trade, err error) {
	var m aggTradeMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Trade{}, fmt.Errorf("binance: decode aggTrade: %w", err)
	}
	side := "buy"
	if m.Maker {
		side = "sell" // buyer is maker => the aggressive (taker) side was a sell
	}
	return norm.NormalizeSymbol(m.Symbol), m.EventT, norm.Trade{
		Price: m.Price, Qty: m.Qty, Side: side, ID: fmt.Sprintf("%d", m.ID),
	}, nil
}

type klineMsg struct {
	Event  string `json:"e"`
	EventT int64  `json:"E"`
	Symbol string `json:"s"`
	K      struct {
		Interval    string `json:"i"`
		Open        string `json:"o"`
		High        string `json:"h"`
		Low         string `json:"l"`
		Close       string `json:"c"`
		Volume      string `json:"v"`
		QuoteVolume string `json:"q"`
		Trades      int    `json:"n"`
		Final       bool   `json:"x"`
	} `json:"k"`
}

// decodeKline returns the normalized symbol, event-time ms, and candle
// payload for one Binance kline message. Final mirrors Binance's own "x"
// (bucket closed) flag — the aggregator only persists final buckets.
func decodeKline(raw []byte) (symbol string, ts int64, candle norm.Candle, err error) {
	var m klineMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Candle{}, fmt.Errorf("binance: decode kline: %w", err)
	}
	return norm.NormalizeSymbol(m.Symbol), m.EventT, norm.Candle{
		TF: m.K.Interval, Open: m.K.Open, High: m.K.High, Low: m.K.Low, Close: m.K.Close,
		Volume: m.K.Volume, QuoteVolume: m.K.QuoteVolume, TradeCount: m.K.Trades, Final: m.K.Final,
	}, nil
}

type markPriceMsg struct {
	Event         string `json:"e"`
	EventT        int64  `json:"E"`
	Symbol        string `json:"s"`
	Rate          string `json:"r"`
	NextFundingTS int64  `json:"T"`
}

// decodeMarkPrice returns the normalized symbol, event-time ms, and funding
// payload for one Binance markPriceUpdate message (the only place Binance
// futures exposes the live funding rate — no separate funding channel).
func decodeMarkPrice(raw []byte) (symbol string, ts int64, funding norm.Funding, err error) {
	var m markPriceMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Funding{}, fmt.Errorf("binance: decode markPrice: %w", err)
	}
	return norm.NormalizeSymbol(m.Symbol), m.EventT, norm.Funding{
		Rate: m.Rate, NextFundingTS: m.NextFundingTS,
	}, nil
}

// partialDepthMsg is one partial-book-depth event (`<symbol>@depth20@100ms`).
// Unlike the diff-depth `@depth` stream (retired at P1.5c so books multiplex
// into this one connection and scale to the full universe — see
// docs/market-data-feeds.md), each partial-depth message carries the FULL
// top-N bids/asks, so it's applied as a snapshot; U/u/pu are ignored.
type partialDepthMsg struct {
	Event  string      `json:"e"`
	EventT int64       `json:"E"`
	Symbol string      `json:"s"`
	Bids   [][2]string `json:"b"`
	Asks   [][2]string `json:"a"`
}

func decodePartialDepth(raw []byte) (symbol string, ts int64, book norm.Book, err error) {
	var m partialDepthMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Book{}, fmt.Errorf("binance: decode partial depth: %w", err)
	}
	return norm.NormalizeSymbol(m.Symbol), m.EventT, norm.Book{
		Bids: toDecLevels(m.Bids), Asks: toDecLevels(m.Asks), Snapshot: true,
	}, nil
}

func toDecLevels(levels [][2]string) [][2]norm.Dec {
	out := make([][2]norm.Dec, len(levels))
	for i, l := range levels {
		out[i] = [2]norm.Dec{l[0], l[1]}
	}
	return out
}

// subscribeParams builds the flat stream-name list for the combined-stream
// SUBSCRIBE method (exchange-websockets skill): "<symbol>@aggTrade",
// "<symbol>@markPrice", "<symbol>@depth<N>@100ms" (partial-book snapshot), and
// "<symbol>@kline_<tf>" for every configured timeframe.
func subscribeParams(symbols []string) []string {
	depth := fmt.Sprintf("@depth%d@100ms", bookDepth)
	params := make([]string, 0, len(symbols)*(3+len(timeframes)))
	for _, sym := range symbols {
		params = append(params, sym+"@aggTrade", sym+"@markPrice", sym+depth)
		for _, tf := range timeframes {
			params = append(params, sym+"@kline_"+tf)
		}
	}
	return params
}

func truncate(raw []byte) string {
	s := string(raw)
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}
