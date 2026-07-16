package aster

import (
	"encoding/json"
	"fmt"

	"github.com/terminal/market-data/internal/norm"
)

// classify peeks the "e" event discriminator every Aster market stream
// message carries. Decoded via a raw key map rather than a one-field struct
// for the same reason as binance.classify: encoding/json's case-insensitive
// fallback would otherwise collide "E" (event time) with a lowercase-"e"
// tagged field. Map keys are never case-folded.
func classify(raw []byte) (string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return "", fmt.Errorf("aster: classify: %w", err)
	}
	eventRaw, ok := top["e"]
	if !ok {
		return "", fmt.Errorf("aster: no event type in message")
	}
	var event string
	if err := json.Unmarshal(eventRaw, &event); err != nil {
		return "", fmt.Errorf("aster: classify event type: %w", err)
	}
	return event, nil
}

type aggTradeMsg struct {
	Event  string `json:"e"`
	EventT int64  `json:"E"`
	Symbol string `json:"s"`
	Price  string `json:"p"`
	Qty    string `json:"q"`
	Maker  bool   `json:"m"` // true if buyer is maker (aggressor sold)
	ID     int64  `json:"a"`
}

func decodeAggTrade(raw []byte) (symbol string, ts int64, trade norm.Trade, err error) {
	var m aggTradeMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Trade{}, fmt.Errorf("aster: decode aggTrade: %w", err)
	}
	side := "buy"
	if m.Maker {
		side = "sell"
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

func decodeKline(raw []byte) (symbol string, ts int64, candle norm.Candle, err error) {
	var m klineMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Candle{}, fmt.Errorf("aster: decode kline: %w", err)
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

func decodeMarkPrice(raw []byte) (symbol string, ts int64, funding norm.Funding, err error) {
	var m markPriceMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, norm.Funding{}, fmt.Errorf("aster: decode markPrice: %w", err)
	}
	return norm.NormalizeSymbol(m.Symbol), m.EventT, norm.Funding{
		Rate: m.Rate, NextFundingTS: m.NextFundingTS,
	}, nil
}

// partialDepthMsg is one partial-book-depth event. Unlike the diff-depth
// stream binance consumes, each partial-depth message carries the FULL top-N
// bids/asks, so it's applied as a snapshot (U/u/pu are ignored — there is no
// incremental state to gap-check).
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
		return "", 0, norm.Book{}, fmt.Errorf("aster: decode partial depth: %w", err)
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

// subscribeParams builds the combined-stream name list: per symbol,
// @aggTrade + @markPrice + @depth<levels>@100ms + @kline_<tf> for each tf.
func subscribeParams(symbols []string) []string {
	depth := fmt.Sprintf("@depth%d@100ms", bookLevels)
	params := make([]string, 0, len(symbols)*(3+len(timeframes)))
	for _, sym := range symbols {
		params = append(params, sym+"@aggTrade", sym+"@markPrice", sym+depth)
		for _, tf := range timeframes {
			params = append(params, sym+"@kline_"+tf)
		}
	}
	return params
}
