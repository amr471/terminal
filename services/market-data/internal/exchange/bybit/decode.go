package bybit

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/terminal/market-data/internal/norm"
)

// topicEnvelope is the shared v5 public-channel wrapper: {"topic":...,
// "type":"snapshot"|"delta","ts":...,"data":...}. Frames with no "topic"
// (subscribe acks, pong replies) aren't an error — classify just reports
// none found, and the read loop skips them.
type topicEnvelope struct {
	Topic string          `json:"topic"`
	Type  string          `json:"type"`
	TS    int64           `json:"ts"`
	Data  json.RawMessage `json:"data"`
}

// classify splits a topic into its parts: "publicTrade.BTCUSDT" ->
// ("publicTrade", ["BTCUSDT"]); "kline.5.BTCUSDT" -> ("kline", ["5",
// "BTCUSDT"]). Returns ok=false for non-topic frames (acks/pongs).
func classify(raw []byte) (kind string, parts []string, env topicEnvelope, ok bool, err error) {
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", nil, topicEnvelope{}, false, fmt.Errorf("bybit: classify: %w", err)
	}
	if env.Topic == "" {
		return "", nil, env, false, nil
	}
	segs := strings.Split(env.Topic, ".")
	return segs[0], segs[1:], env, true, nil
}

type tradeMsg struct {
	TS     int64  `json:"T"`
	Symbol string `json:"s"`
	Side   string `json:"S"` // "Buy" | "Sell"
	Qty    string `json:"v"`
	Price  string `json:"p"`
	ID     string `json:"i"`
}

// decodeTrades returns one norm.Trade per element (Bybit batches multiple
// prints into a single publicTrade message).
func decodeTrades(env topicEnvelope) ([]tradeOut, error) {
	var msgs []tradeMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return nil, fmt.Errorf("bybit: decode publicTrade: %w", err)
	}
	out := make([]tradeOut, 0, len(msgs))
	for _, m := range msgs {
		side := "buy"
		if strings.EqualFold(m.Side, "Sell") {
			side = "sell"
		}
		out = append(out, tradeOut{
			Symbol: norm.NormalizeSymbol(m.Symbol), TS: m.TS,
			Trade: norm.Trade{Price: m.Price, Qty: m.Qty, Side: side, ID: m.ID},
		})
	}
	return out, nil
}

type tradeOut struct {
	Symbol string
	TS     int64
	Trade  norm.Trade
}

type klineMsg struct {
	Start    int64  `json:"start"`
	Interval string `json:"interval"`
	Open     string `json:"open"`
	High     string `json:"high"`
	Low      string `json:"low"`
	Close    string `json:"close"`
	Volume   string `json:"volume"`
	Turnover string `json:"turnover"`
	Confirm  bool   `json:"confirm"`
}

// decodeKlines returns one norm.Candle per element. tf comes from the topic
// ("kline.{interval}.{symbol}"), mapped back through tfFor, not the payload
// — the topic is what we actually subscribed with, so it can't be wrong even
// if a future Bybit response ever omitted "interval" from the payload.
func decodeKlines(topicParts []string, env topicEnvelope) (symbol, tf string, out []klineOut, err error) {
	if len(topicParts) < 2 {
		return "", "", nil, fmt.Errorf("bybit: malformed kline topic parts %v", topicParts)
	}
	interval, sym := topicParts[0], topicParts[1]
	tf, ok := tfFor[interval]
	if !ok {
		return "", "", nil, fmt.Errorf("bybit: unknown kline interval %q", interval)
	}
	var msgs []klineMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return "", "", nil, fmt.Errorf("bybit: decode kline: %w", err)
	}
	for _, m := range msgs {
		out = append(out, klineOut{
			TS: m.Start,
			Candle: norm.Candle{
				TF: tf, Open: m.Open, High: m.High, Low: m.Low, Close: m.Close,
				Volume: m.Volume, QuoteVolume: m.Turnover, Final: m.Confirm,
			},
		})
	}
	return norm.NormalizeSymbol(sym), tf, out, nil
}

type klineOut struct {
	TS     int64
	Candle norm.Candle
}

type tickerMsg struct {
	Symbol          string  `json:"symbol"`
	FundingRate     *string `json:"fundingRate"`
	NextFundingTime *string `json:"nextFundingTime"`
	OpenInterest    *string `json:"openInterest"`
	OpenInterestUSD *string `json:"openInterestValue"`
}

// decodeTicker returns funding/OI updates present on THIS message only —
// tickers deltas omit unchanged fields, so a nil pointer here means "not on
// this update," not "zero."
func decodeTicker(topicParts []string, env topicEnvelope) (symbol string, ts int64, funding *norm.Funding, oi *norm.OI, err error) {
	if len(topicParts) < 1 {
		return "", 0, nil, nil, fmt.Errorf("bybit: malformed tickers topic")
	}
	var m tickerMsg
	if err := json.Unmarshal(env.Data, &m); err != nil {
		return "", 0, nil, nil, fmt.Errorf("bybit: decode tickers: %w", err)
	}
	symbol = norm.NormalizeSymbol(topicParts[0])
	ts = env.TS
	if m.FundingRate != nil {
		f := norm.Funding{Rate: *m.FundingRate}
		if m.NextFundingTime != nil {
			if ms, err := strconv.ParseInt(*m.NextFundingTime, 10, 64); err == nil {
				f.NextFundingTS = ms
			}
		}
		funding = &f
	}
	if m.OpenInterest != nil {
		o := norm.OI{OpenInterest: *m.OpenInterest}
		if m.OpenInterestUSD != nil {
			o.OpenInterestUSD = *m.OpenInterestUSD
		}
		oi = &o
	}
	return symbol, ts, funding, oi, nil
}

type orderbookMsg struct {
	Symbol string      `json:"s"`
	Bids   [][2]string `json:"b"`
	Asks   [][2]string `json:"a"`
	U      uint64      `json:"u"`
	Seq    uint64      `json:"seq"`
}

func decodeOrderbook(env topicEnvelope) (orderbookMsg, error) {
	var m orderbookMsg
	if err := json.Unmarshal(env.Data, &m); err != nil {
		return orderbookMsg{}, fmt.Errorf("bybit: decode orderbook: %w", err)
	}
	return m, nil
}

// subscribeArgs builds the v5 combined "args" list: "publicTrade.{sym}",
// "tickers.{sym}", "orderbook.{depth}.{sym}", and "kline.{interval}.{sym}"
// per timeframe — for every configured symbol. Orderbook is multiplexed here
// (P1.5c) rather than a per-symbol BookFeed so books scale to the full
// universe; per-symbol sequence tracking stays inside WSFeed.
func subscribeArgs(symbols []string) []string {
	args := make([]string, 0, len(symbols)*(3+len(timeframes)))
	for _, sym := range symbols {
		upper := strings.ToUpper(sym)
		args = append(args, "publicTrade."+upper, "tickers."+upper, orderbookTopic(sym))
		for _, tf := range timeframes {
			args = append(args, "kline."+intervalFor[tf]+"."+upper)
		}
	}
	return args
}

// orderbookTopic builds "orderbook.{depth}.{SYMBOL}".
func orderbookTopic(symbol string) string {
	return fmt.Sprintf("orderbook.%d.%s", bookDepth, strings.ToUpper(symbol))
}

func toDecLevels(levels [][2]string) [][2]norm.Dec {
	out := make([][2]norm.Dec, len(levels))
	for i, l := range levels {
		out[i] = [2]norm.Dec{l[0], l[1]}
	}
	return out
}
