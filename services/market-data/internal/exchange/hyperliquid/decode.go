package hyperliquid

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/terminal/market-data/internal/norm"
)

// flexStr is a string decimal that unmarshals from EITHER a JSON string
// ("64000.5") or a JSON number (64000.5). HyperLiquid's wire types are
// documented as numbers for candle o/c/h/l/v and ctx funding/openInterest,
// but strings for trade/book px/sz, and the two aren't always consistent in
// practice — decoding both into one string decimal (architecture.md §4.3:
// never float64 on the wire) sidesteps that entirely.
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
	*s = flexStr(b) // numeric literal, kept verbatim
	return nil
}

// envelope is the top-level ws frame: {"channel":"trades","data":...}.
type envelope struct {
	Channel string          `json:"channel"`
	Data    json.RawMessage `json:"data"`
}

// classify extracts the channel and raw data, or ok=false for frames that
// carry nothing to route (subscriptionResponse, pong, error acks).
func classify(raw []byte) (channel string, data json.RawMessage, ok bool, err error) {
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", nil, false, fmt.Errorf("hyperliquid: classify: %w", err)
	}
	switch e.Channel {
	case "trades", "l2Book", "candle", "activeAssetCtx":
		return e.Channel, e.Data, true, nil
	default:
		return e.Channel, nil, false, nil // subscriptionResponse / pong / error
	}
}

type tradeOut struct {
	Symbol string
	TS     int64
	Trade  norm.Trade
}

type wsTrade struct {
	Coin string `json:"coin"`
	Side string `json:"side"` // "B" (buy aggressor) | "A" (sell) — VERIFY
	Px   string `json:"px"`
	Sz   string `json:"sz"`
	Time int64  `json:"time"`
	Tid  int64  `json:"tid"`
}

func decodeTrades(data json.RawMessage) ([]tradeOut, error) {
	var msgs []wsTrade
	if err := json.Unmarshal(data, &msgs); err != nil {
		return nil, fmt.Errorf("hyperliquid: decode trades: %w", err)
	}
	out := make([]tradeOut, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, tradeOut{
			Symbol: symbolFor(m.Coin), TS: m.Time,
			Trade: norm.Trade{Price: m.Px, Qty: m.Sz, Side: sideFor(m.Side), ID: strconv.FormatInt(m.Tid, 10)},
		})
	}
	return out, nil
}

// sideFor maps HL's side letter to our "buy"/"sell". "B" is the buy-aggressor
// side; anything else is treated as a sell. VERIFY against live docs.
func sideFor(letter string) string {
	if letter == "B" {
		return "buy"
	}
	return "sell"
}

type bookOut struct {
	Symbol string
	TS     int64
	Book   norm.Book
}

type wsLevel struct {
	Px string `json:"px"`
	Sz string `json:"sz"`
	N  int    `json:"n"`
}

type wsBook struct {
	Coin   string      `json:"coin"`
	Levels [][]wsLevel `json:"levels"` // [bids, asks]
	Time   int64       `json:"time"`
}

// decodeBook turns HL's full-snapshot l2Book into a norm.Book with
// Snapshot=true (each message replaces the whole book — no deltas, no seq).
func decodeBook(data json.RawMessage) (bookOut, error) {
	var m wsBook
	if err := json.Unmarshal(data, &m); err != nil {
		return bookOut{}, fmt.Errorf("hyperliquid: decode l2Book: %w", err)
	}
	if len(m.Levels) != 2 {
		return bookOut{}, fmt.Errorf("hyperliquid: l2Book levels = %d, want 2", len(m.Levels))
	}
	return bookOut{
		Symbol: symbolFor(m.Coin), TS: m.Time,
		Book: norm.Book{Bids: levelsToDec(m.Levels[0]), Asks: levelsToDec(m.Levels[1]), Snapshot: true},
	}, nil
}

func levelsToDec(levels []wsLevel) [][2]norm.Dec {
	out := make([][2]norm.Dec, 0, len(levels))
	for _, l := range levels {
		out = append(out, [2]norm.Dec{l.Px, l.Sz})
	}
	return out
}

type candleOut struct {
	Symbol string
	TS     int64
	Candle norm.Candle
}

type wsCandle struct {
	T int64   `json:"t"` // open millis
	S string  `json:"s"` // coin
	I string  `json:"i"` // interval
	O flexStr `json:"o"`
	C flexStr `json:"c"`
	H flexStr `json:"h"`
	L flexStr `json:"l"`
	V flexStr `json:"v"`
	N int     `json:"n"`
}

// decodeCandle decodes one candle frame. Final is left false here; the WSFeed
// sets it via candleTracker rollover (HL has no closed-bucket flag on the
// wire). ts is the candle open time.
func decodeCandle(data json.RawMessage) (candleOut, error) {
	var m wsCandle
	if err := json.Unmarshal(data, &m); err != nil {
		return candleOut{}, fmt.Errorf("hyperliquid: decode candle: %w", err)
	}
	return candleOut{
		Symbol: symbolFor(m.S), TS: m.T,
		Candle: norm.Candle{
			TF: m.I, Open: string(m.O), High: string(m.H), Low: string(m.L),
			Close: string(m.C), Volume: string(m.V), TradeCount: m.N,
		},
	}, nil
}

type ctxOut struct {
	Symbol  string
	TS      int64
	Funding *norm.Funding
	OI      *norm.OI
}

type wsAssetCtx struct {
	Coin string `json:"coin"`
	Ctx  struct {
		Funding      flexStr `json:"funding"`
		OpenInterest flexStr `json:"openInterest"`
	} `json:"ctx"`
}

// decodeAssetCtx yields funding AND open interest from the single
// activeAssetCtx frame. HL sends no per-message timestamp here, so the caller
// stamps receive time into ts (package doc VERIFY).
func decodeAssetCtx(data json.RawMessage) (ctxOut, error) {
	var m wsAssetCtx
	if err := json.Unmarshal(data, &m); err != nil {
		return ctxOut{}, fmt.Errorf("hyperliquid: decode activeAssetCtx: %w", err)
	}
	out := ctxOut{Symbol: symbolFor(m.Coin)}
	if m.Ctx.Funding != "" {
		out.Funding = &norm.Funding{Rate: string(m.Ctx.Funding)}
	}
	if m.Ctx.OpenInterest != "" {
		out.OI = &norm.OI{OpenInterest: string(m.Ctx.OpenInterest)}
	}
	return out, nil
}

// candleTracker turns HyperLiquid's flag-less candle stream into final-bucket
// signals by watching each (symbol,tf) bucket's open time roll forward. When a
// message arrives for a later bucket than the one last seen, the previous
// bucket is now closed: observe returns it with Final=true. The live
// (in-progress) candle is always returned with Final=false so charts update.
type candleTracker struct {
	last map[string]candleOut // key: symbol|tf -> last-seen in-progress candle
}

func newCandleTracker() *candleTracker { return &candleTracker{last: map[string]candleOut{}} }

// observe records c and returns (finalized, hasFinalized) plus the live candle
// to emit. finalized is the just-closed prior bucket (Final=true) when c
// starts a new bucket; live is c with Final=false.
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
