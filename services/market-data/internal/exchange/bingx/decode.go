package bingx

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/terminal/market-data/internal/norm"
)

// decompress gunzips a server frame. Every BingX websocket message is
// GZIP-compressed (package doc); this is the first thing the read loop does.
func decompress(raw []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("bingx: gzip reader: %w", err)
	}
	defer func() { _ = zr.Close() }()
	out, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("bingx: gunzip: %w", err)
	}
	return out, nil
}

// flexStr unmarshals a JSON string OR number into a string decimal.
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

// envelope is a decompressed data frame: {"code":0,"dataType":"BTC-USDT@trade",
// "data":...}. Subscribe acks ({"id","code","msg"}) carry no dataType.
type envelope struct {
	DataType string          `json:"dataType"`
	Data     json.RawMessage `json:"data"`
}

// parseDataType splits a dataType string into the wire symbol, the channel
// kind (trade/kline/depth), and — for kline — the interval code. Examples:
// "BTC-USDT@trade" -> ("BTC-USDT","trade",""); "BTC-USDT@kline_1min" ->
// (...,"kline","1min"); "BTC-USDT@depth20@200ms" -> (...,"depth","").
func parseDataType(dt string) (wire, kind, interval string, ok bool) {
	sym, rest, found := strings.Cut(dt, "@")
	if !found {
		return "", "", "", false
	}
	switch {
	case strings.HasPrefix(rest, "trade"):
		return sym, "trade", "", true
	case strings.HasPrefix(rest, "kline_"):
		iv, _, _ := strings.Cut(rest[len("kline_"):], "@")
		return sym, "kline", iv, true
	case strings.HasPrefix(rest, "depth"):
		return sym, "depth", "", true
	default:
		return sym, "", "", false
	}
}

// classify gunzips, then returns the parsed dataType components + raw data, or
// ok=false for a Ping/ack/unknown frame (Ping is handled before classify).
func classify(decompressed []byte) (wire, kind, interval string, data json.RawMessage, ok bool, err error) {
	var e envelope
	if err := json.Unmarshal(decompressed, &e); err != nil {
		return "", "", "", nil, false, fmt.Errorf("bingx: classify: %w", err)
	}
	if e.DataType == "" {
		return "", "", "", nil, false, nil // subscribe ack / error
	}
	w, k, iv, parsed := parseDataType(e.DataType)
	if !parsed {
		return "", "", "", nil, false, nil // a channel we don't consume (ticker/bookTicker/...)
	}
	return w, k, iv, e.Data, true, nil
}

type tradeOut struct {
	Symbol string
	TS     int64
	Trade  norm.Trade
}

// tradeMsg mirrors BingX swap @trade: T=transaction time (ms), m=buyer is
// maker (true => taker sold), p=price, q=volume.
type tradeMsg struct {
	T int64   `json:"T"`
	S string  `json:"s"`
	M bool    `json:"m"`
	P flexStr `json:"p"`
	Q flexStr `json:"q"`
}

// decodeTrades accepts either an array of trades or a single trade object
// (BingX has shipped both shapes across versions).
func decodeTrades(wire string, data json.RawMessage) ([]tradeOut, error) {
	trimmed := bytes.TrimSpace(data)
	var msgs []tradeMsg
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(data, &msgs); err != nil {
			return nil, fmt.Errorf("bingx: decode trades: %w", err)
		}
	} else {
		var one tradeMsg
		if err := json.Unmarshal(data, &one); err != nil {
			return nil, fmt.Errorf("bingx: decode trade: %w", err)
		}
		msgs = []tradeMsg{one}
	}
	out := make([]tradeOut, 0, len(msgs))
	for i, m := range msgs {
		sym := m.S
		if sym == "" {
			sym = wire
		}
		out = append(out, tradeOut{
			Symbol: norm.NormalizeSymbol(sym), TS: m.T,
			Trade: norm.Trade{Price: string(m.P), Qty: string(m.Q), Side: sideFor(m.M), ID: strconv.Itoa(i)},
		})
	}
	return out, nil
}

// sideFor: m=true means the buyer is the maker, so the aggressor (taker) sold.
func sideFor(buyerIsMaker bool) string {
	if buyerIsMaker {
		return "sell"
	}
	return "buy"
}

type candleOut struct {
	Symbol string
	TS     int64
	Candle norm.Candle
}

// klineMsg mirrors BingX swap @kline: a Binance-flavored {e,E,s,K{...}}. The K
// bucket has no closed flag, so Final is set by candleTracker rollover.
type klineMsg struct {
	S string `json:"s"`
	K struct {
		// Both "t" (start) and "T" (end) must be declared, or encoding/json's
		// case-insensitive fallback folds "T" onto a lone "t" field (same trap
		// as binance.classify). We key candles on the start time.
		Start int64   `json:"t"` // bucket start, ms
		End   int64   `json:"T"` // bucket end, ms (declared to avoid folding)
		O     flexStr `json:"o"`
		C     flexStr `json:"c"`
		H     flexStr `json:"h"`
		L     flexStr `json:"l"`
		V     flexStr `json:"v"`
		Q     flexStr `json:"q"`
	} `json:"K"`
}

func decodeKline(wire, interval string, data json.RawMessage) (candleOut, error) {
	tf, ok := tfForKlineInterval[interval]
	if !ok {
		return candleOut{}, fmt.Errorf("bingx: unknown kline interval %q", interval)
	}
	var m klineMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return candleOut{}, fmt.Errorf("bingx: decode kline: %w", err)
	}
	sym := m.S
	if sym == "" {
		sym = wire
	}
	return candleOut{
		Symbol: norm.NormalizeSymbol(sym), TS: m.K.Start,
		Candle: norm.Candle{
			TF: tf, Open: string(m.K.O), High: string(m.K.H), Low: string(m.K.L),
			Close: string(m.K.C), Volume: string(m.K.V), QuoteVolume: string(m.K.Q),
		},
	}, nil
}

type bookOut struct {
	Symbol string
	TS     int64
	Book   norm.Book
}

// depthMsg mirrors BingX swap @depth<level>: a limited full snapshot. Levels
// are [price, qty] arrays; ts is the match-engine time in ms.
type depthMsg struct {
	Bids [][2]flexStr `json:"bids"`
	Asks [][2]flexStr `json:"asks"`
	TS   int64        `json:"ts"`
}

func decodeDepth(wire string, data json.RawMessage) (bookOut, error) {
	var m depthMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return bookOut{}, fmt.Errorf("bingx: decode depth: %w", err)
	}
	return bookOut{
		Symbol: norm.NormalizeSymbol(wire), TS: m.TS,
		Book: norm.Book{Bids: levelsToDec(m.Bids), Asks: levelsToDec(m.Asks), Snapshot: true},
	}, nil
}

func levelsToDec(levels [][2]flexStr) [][2]norm.Dec {
	out := make([][2]norm.Dec, 0, len(levels))
	for _, l := range levels {
		out = append(out, [2]norm.Dec{string(l[0]), string(l[1])})
	}
	return out
}

// candleTracker — BingX kline has no closed-bucket flag, so a new bucket's
// start time finalizes the previous one (same as HyperLiquid/KuCoin/MEXC).
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
