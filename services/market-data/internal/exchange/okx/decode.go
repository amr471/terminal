package okx

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/terminal/market-data/internal/norm"
)

// argEnvelope is the shared v5 public-channel wrapper. Subscribe
// acks/errors carry "event" instead of "arg"/"data" — classify treats those
// as ignorable, same as Bybit's non-topic frames.
type argEnvelope struct {
	Event string `json:"event,omitempty"`
	Arg   *struct {
		Channel string `json:"channel"`
		InstID  string `json:"instId"`
	} `json:"arg,omitempty"`
	Action string          `json:"action,omitempty"` // "books" channel only: snapshot|update
	Data   json.RawMessage `json:"data,omitempty"`
}

// classify handles OKX's literal-text ping/pong (not a JSON frame) before
// attempting to decode anything as JSON, then reports the channel name +
// instId, or ok=false for acks/errors/pongs.
func classify(raw []byte) (channel, instID, action string, env argEnvelope, ok bool, err error) {
	if string(raw) == "pong" {
		return "", "", "", argEnvelope{}, false, nil
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", "", "", argEnvelope{}, false, fmt.Errorf("okx: classify: %w", err)
	}
	if env.Arg == nil {
		return "", "", "", env, false, nil // subscribe ack / error frame
	}
	return env.Arg.Channel, env.Arg.InstID, env.Action, env, true, nil
}

type tradeMsg struct {
	InstID string `json:"instId"`
	Px     string `json:"px"`
	Sz     string `json:"sz"`
	Side   string `json:"side"` // "buy" | "sell"
	TS     string `json:"ts"`   // epoch ms, as a string
	ID     string `json:"tradeId"`
}

func decodeTrades(env argEnvelope) ([]tradeOut, error) {
	var msgs []tradeMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return nil, fmt.Errorf("okx: decode trades: %w", err)
	}
	out := make([]tradeOut, 0, len(msgs))
	for _, m := range msgs {
		ts, _ := strconv.ParseInt(m.TS, 10, 64)
		out = append(out, tradeOut{
			Symbol: fromInstID(m.InstID), TS: ts,
			Trade: norm.Trade{Price: m.Px, Qty: m.Sz, Side: m.Side, ID: m.ID},
		})
	}
	return out, nil
}

type tradeOut struct {
	Symbol string
	TS     int64
	Trade  norm.Trade
}

// decodeCandles handles OKX's positional-array candle payload:
// [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]. Bounds-
// checked rather than assuming a fixed length — OKX has changed the tail of
// this array across API versions (adding volCcyQuote, for instance), so this
// reads by position from the front (stable) and treats the *last* element as
// the confirm flag (also stable) rather than a fixed index.
func decodeCandles(channel, instID string, env argEnvelope) (symbol, tf string, out []klineOut, err error) {
	tf, ok := tfForChannel[channel]
	if !ok {
		return "", "", nil, fmt.Errorf("okx: unknown candle channel %q", channel)
	}
	var rows [][]string
	if err := json.Unmarshal(env.Data, &rows); err != nil {
		return "", "", nil, fmt.Errorf("okx: decode candles: %w", err)
	}
	symbol = fromInstID(instID)
	for _, row := range rows {
		if len(row) < 6 {
			continue // malformed row from a hostile feed; skip rather than panic on index
		}
		ts, _ := strconv.ParseInt(row[0], 10, 64)
		final := row[len(row)-1] == "1"
		c := norm.Candle{TF: tf, Open: row[1], High: row[2], Low: row[3], Close: row[4], Volume: row[5], Final: final}
		if len(row) >= 7 {
			c.QuoteVolume = row[6]
		}
		out = append(out, klineOut{TS: ts, Candle: c})
	}
	return symbol, tf, out, nil
}

type klineOut struct {
	TS     int64
	Candle norm.Candle
}

type fundingMsg struct {
	InstID        string `json:"instId"`
	FundingRate   string `json:"fundingRate"`
	FundingTime   string `json:"fundingTime"`
	NextFundingTS string `json:"nextFundingTime"`
}

func decodeFunding(env argEnvelope) (symbol string, ts int64, funding norm.Funding, err error) {
	var msgs []fundingMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return "", 0, norm.Funding{}, fmt.Errorf("okx: decode funding-rate: %w", err)
	}
	if len(msgs) == 0 {
		return "", 0, norm.Funding{}, fmt.Errorf("okx: empty funding-rate data")
	}
	m := msgs[0]
	ts, _ = strconv.ParseInt(m.FundingTime, 10, 64)
	next, _ := strconv.ParseInt(m.NextFundingTS, 10, 64)
	return fromInstID(m.InstID), ts, norm.Funding{Rate: m.FundingRate, NextFundingTS: next}, nil
}

type oiMsg struct {
	InstID string `json:"instId"`
	OI     string `json:"oi"`
	OIUsd  string `json:"oiUsd"`
	TS     string `json:"ts"`
}

func decodeOI(env argEnvelope) (symbol string, ts int64, oi norm.OI, err error) {
	var msgs []oiMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return "", 0, norm.OI{}, fmt.Errorf("okx: decode open-interest: %w", err)
	}
	if len(msgs) == 0 {
		return "", 0, norm.OI{}, fmt.Errorf("okx: empty open-interest data")
	}
	m := msgs[0]
	ts, _ = strconv.ParseInt(m.TS, 10, 64)
	return fromInstID(m.InstID), ts, norm.OI{OpenInterest: m.OI, OpenInterestUSD: m.OIUsd}, nil
}

// bookMsg is one "books" channel data element. Each level is
// [price, size, numLiquidatedOrders, numOrders] — a 4-tuple, unlike
// Binance/Bybit's [price,qty] pairs (package doc). Checksum verification is
// deliberately not implemented (docs/market-data-feeds.md): seqId/prevSeqId
// continuity already satisfies §5.3's gap-detection mandate; checksum is a
// stronger integrity check on top of it, scoped out for P1.5a.
type bookMsg struct {
	Bids      [][]string `json:"bids"`
	Asks      [][]string `json:"asks"`
	TS        string     `json:"ts"`
	SeqID     int64      `json:"seqId"`
	PrevSeqID int64      `json:"prevSeqId"`
}

func decodeBook(env argEnvelope) (bookMsg, error) {
	var msgs []bookMsg
	if err := json.Unmarshal(env.Data, &msgs); err != nil {
		return bookMsg{}, fmt.Errorf("okx: decode books: %w", err)
	}
	if len(msgs) == 0 {
		return bookMsg{}, fmt.Errorf("okx: empty books data")
	}
	return msgs[0], nil
}

// decodeBook5 handles the `books5` channel — a full top-5 snapshot pushed
// every 100ms (no deltas, no seqId continuity to track). P1.5c multiplexes
// this into the ws feed instead of the per-symbol diff-depth `books` BookFeed
// so books scale to the full instrument universe (docs/market-data-feeds.md).
func decodeBook5(instID string, env argEnvelope) (symbol string, ts int64, book norm.Book, err error) {
	m, err := decodeBook(env)
	if err != nil {
		return "", 0, norm.Book{}, err
	}
	ts, _ = strconv.ParseInt(m.TS, 10, 64)
	return fromInstID(instID), ts, norm.Book{
		Bids: levelsToDec(m.Bids), Asks: levelsToDec(m.Asks), Snapshot: true,
	}, nil
}

func levelsToDec(levels [][]string) [][2]norm.Dec {
	out := make([][2]norm.Dec, 0, len(levels))
	for _, l := range levels {
		if len(l) < 2 {
			continue
		}
		out = append(out, [2]norm.Dec{l[0], l[1]})
	}
	return out
}

type subscribeArg struct {
	Channel string `json:"channel"`
	InstID  string `json:"instId"`
}

// subscribeArgsFor builds the trades + candles + funding-rate + open-interest
// arg list for every configured symbol that maps to a valid SWAP instId
// (toInstID). Symbols that don't map (non-USDT-quoted, out of this
// package's documented scope) are skipped, not silently mangled.
func subscribeArgsFor(symbols []string) []subscribeArg {
	args := make([]subscribeArg, 0, len(symbols)*(3+len(timeframes)))
	for _, sym := range symbols {
		instID, ok := toInstID(sym)
		if !ok {
			continue
		}
		args = append(args,
			subscribeArg{Channel: "trades", InstID: instID},
			subscribeArg{Channel: "funding-rate", InstID: instID},
			subscribeArg{Channel: "open-interest", InstID: instID},
			subscribeArg{Channel: "books5", InstID: instID},
		)
		for _, tf := range timeframes {
			args = append(args, subscribeArg{Channel: candleChannel[tf], InstID: instID})
		}
	}
	return args
}
