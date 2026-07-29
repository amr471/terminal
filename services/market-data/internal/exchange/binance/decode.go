package binance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/shopspring/decimal"

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

// flexStr unmarshals a JSON string OR number into a string decimal, keeping
// values as string decimals end to end (architecture.md §4.3, never float64 on
// the wire). Same helper mexc/decode.go already needed.
//
// Real bug found on a live run 2026-07-26: Binance normally quotes every OHLCV
// field, but some symbols push a bare number — the log filled with `decode
// kline: json: cannot unmarshal number into Go struct field .k.l of type
// string`, and EVERY candle for that symbol was discarded (so its candles
// hypertable stayed empty, and with it the candle-derived stats for any venue
// still on that path). Accepting both shapes is strictly more permissive than
// the previous `string`, so nothing that decoded before stops decoding.
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
	*s = flexStr(b) // bare number: keep its exact digits, never via float64
	return nil
}

// Every key inside "k" is declared for the same case-folding reason spelled out
// on tickerMsg. Two of these were actively corrupting data before 2026-07-26:
// `V` (taker-buy BASE volume) folded onto `v` (total volume) and `Q` (taker-buy
// QUOTE volume) folded onto `q` (total quote volume) — and because both
// uppercase keys arrive AFTER their lowercase twins in Binance's object, they
// won, so every stored candle's volume was really just the taker-buy share.
// That fed Volume24h, so candle-derived 24h volumes were understated too.
//
//nolint:unused // fields exist to claim JSON keys; see the comment above.
type klineMsg struct {
	Event  string `json:"e"`
	EventT int64  `json:"E"`
	Symbol string `json:"s"`
	K      struct {
		StartT       int64   `json:"t"`
		CloseT       int64   `json:"T"`
		Symbol       string  `json:"s"`
		Interval     string  `json:"i"`
		FirstTradeI  int64   `json:"f"`
		LastTradeI   int64   `json:"L"`
		Open         flexStr `json:"o"`
		Close        flexStr `json:"c"`
		High         flexStr `json:"h"`
		Low          flexStr `json:"l"`
		Volume       flexStr `json:"v"`
		Trades       int     `json:"n"`
		Final        bool    `json:"x"`
		QuoteVolume  flexStr `json:"q"`
		TakerBaseVol flexStr `json:"V"`
		TakerQuoteV  flexStr `json:"Q"`
		Ignore       flexStr `json:"B"`
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
		TF: m.K.Interval, Open: string(m.K.Open), High: string(m.K.High),
		Low: string(m.K.Low), Close: string(m.K.Close),
		Volume: string(m.K.Volume), QuoteVolume: string(m.K.QuoteVolume),
		TradeCount: m.K.Trades, Final: m.K.Final,
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

// marketSubscribeParams builds the flat stream-name list for WSFeed's
// combined-stream SUBSCRIBE method (exchange-websockets skill):
// "<symbol>@aggTrade", "<symbol>@markPrice", and "<symbol>@kline_<tf>" for
// every configured timeframe — everything Binance now routes to /market.
// Depth moved to depthSubscribeParams (DepthFeed, /public route) at the
// 2026-07-17 routing split; see package doc in binance.go.
func marketSubscribeParams(symbols []string) []string {
	params := make([]string, 0, len(symbols)*(2+len(timeframes)))
	for _, sym := range symbols {
		params = append(params, sym+"@aggTrade", sym+"@markPrice")
		for _, tf := range timeframes {
			params = append(params, sym+"@kline_"+tf)
		}
	}
	return params
}

// tickerMsg is one element of a `!ticker@arr` frame (Binance's 24hrTicker
// shape, verified against the USDⓈ-M futures docs 2026-07-25). `P` is a
// PERCENT string ("-5.2" = -5.2%), so it needs converting to the fraction
// convention norm.Ticker/instrument_state use — see pctToFraction.
// Numeric fields are flexStr for the same reason klineMsg's are: Binance
// quotes them for most symbols but pushes bare numbers for some (real bug,
// 2026-07-26). A single unquoted field would otherwise fail the WHOLE frame's
// unmarshal — and one `!ticker@arr` frame carries every symbol on the venue,
// so that would cost us the entire universe, not one coin.
//
// EVERY field Binance sends is declared, including ones we never read. That is
// load-bearing, not tidiness — real bug found 2026-07-26: prices rendered as
// 1,785,263,923,377 (a ms timestamp) for nearly every symbol. encoding/json
// matches an exact tag first and then falls back to CASE-INSENSITIVE matching,
// and 24hrTicker carries both `c` (last price) and `C` (statistics close time).
// With no field tagged `C`, the `C` key fell back onto `Last` (tagged `c`) and,
// arriving later in the object, overwrote the price with the close time. The
// same collision pairs exist for l/L (low vs last trade id), q/Q (quote volume
// vs last qty), o/O (open vs stats open time) and p/P (price change vs
// percent). Declaring each uppercase key gives it an exact match, so it can
// never be folded onto its lowercase twin. This is the identical trap
// classify() documents at the top of this file.
//
//nolint:unused // fields exist to claim JSON keys; see the comment above.
type tickerMsg struct {
	Event       string  `json:"e"`
	EventT      int64   `json:"E"`
	Symbol      string  `json:"s"`
	PriceChange flexStr `json:"p"`
	ChangePct   flexStr `json:"P"`
	WeightedAvg flexStr `json:"w"`
	Last        flexStr `json:"c"`
	LastQty     flexStr `json:"Q"`
	Open        flexStr `json:"o"`
	High        flexStr `json:"h"`
	Low         flexStr `json:"l"`
	BaseVolume  flexStr `json:"v"`
	QuoteVolume flexStr `json:"q"`
	StatsOpenT  int64   `json:"O"`
	StatsCloseT int64   `json:"C"`
	FirstTradeI int64   `json:"F"`
	LastTradeI  int64   `json:"L"`
	TradeCount  int64   `json:"n"`
}

// decodedTicker pairs a normalized symbol + event time with its payload.
type decodedTicker struct {
	symbol string
	ts     int64
	ticker norm.Ticker
}

// decodeAllTickers decodes one `!ticker@arr` frame — a JSON ARRAY of 24hrTicker
// objects, one per symbol. ok=false for any frame that isn't such an array
// (notably the `{"result":null,"id":1}` subscribe ack), which is normal traffic
// and not worth logging. Malformed entries are skipped individually rather than
// discarding the whole frame: one bad symbol shouldn't cost us the other
// thousand in the same push.
func decodeAllTickers(raw []byte, log *slog.Logger) ([]decodedTicker, bool) {
	var msgs []tickerMsg
	if err := json.Unmarshal(raw, &msgs); err != nil {
		return nil, false // ack or non-array frame
	}
	out := make([]decodedTicker, 0, len(msgs))
	for _, m := range msgs {
		if m.Symbol == "" || m.Last == "" {
			continue
		}
		ts := m.EventT
		if ts == 0 {
			ts = time.Now().UnixMilli()
		}
		out = append(out, decodedTicker{
			symbol: norm.NormalizeSymbol(m.Symbol),
			ts:     ts,
			ticker: norm.Ticker{
				Last:           string(m.Last),
				Volume24h:      string(m.BaseVolume),
				QuoteVolume24h: string(m.QuoteVolume),
				Change24h:      pctToFraction(string(m.ChangePct), log),
				High24h:        string(m.High),
				Low24h:         string(m.Low),
			},
		})
	}
	return out, true
}

// pctToFraction converts a venue's percent string ("-5.2") to the fraction
// convention norm.Ticker.Change24h and instrument_state.change_* use
// ("-0.052"). Exact decimal division — never float, per architecture.md §4.3.
// Returns "" for an empty or unparseable input so the field is simply omitted
// rather than written as a wrong number.
func pctToFraction(pct string, log *slog.Logger) string {
	if pct == "" {
		return ""
	}
	d, err := decimal.NewFromString(pct)
	if err != nil {
		if log != nil {
			log.Warn("binance: malformed ticker percent", "value", pct)
		}
		return ""
	}
	return d.Div(decimal.NewFromInt(100)).String()
}

// maxParamsPerSubscribe caps how many stream names go in a single SUBSCRIBE
// frame. Binance's per-connection limit is 1024 streams (verified against the
// USDⓈ-M futures docs), but that's the CUMULATIVE cap across all SUBSCRIBE
// messages on a connection — it is NOT a per-message limit. A single oversized
// SUBSCRIBE (e.g. WSFeed's ~832 params for ~100 symbols × 8 streams) is
// rejected by Binance's gateway with `websocket: close 1008 (policy
// violation): Invalid request`, even though the total is under 1024. Root-
// caused 2026-07-22: the DepthFeed's single 96-param SUBSCRIBE on the same
// server family connects cleanly, so ≤96 params/frame is known-good; WSFeed's
// single 832-param frame is the only variable that differs and it always
// 1008s. 80 leaves margin under that proven-good 96. See subscribeInChunks.
const maxParamsPerSubscribe = 80

// chunkParams splits a flat stream-name list into batches no larger than size,
// preserving order and every element. size<=0 returns the whole list as one
// batch. Used to send WSFeed's SUBSCRIBE as several small frames instead of one
// oversized frame Binance rejects (see maxParamsPerSubscribe).
func chunkParams(params []string, size int) [][]string {
	if size <= 0 || len(params) <= size {
		return [][]string{params}
	}
	var out [][]string
	for i := 0; i < len(params); i += size {
		end := i + size
		if end > len(params) {
			end = len(params)
		}
		out = append(out, params[i:end])
	}
	return out
}

// depthSubscribeParams builds DepthFeed's stream-name list:
// "<symbol>@depth<N>@100ms" (partial-book snapshot) per symbol — the one
// stream Binance now routes to /public. Split out of marketSubscribeParams
// at the 2026-07-17 routing migration; see package doc in binance.go.
func depthSubscribeParams(symbols []string) []string {
	depth := fmt.Sprintf("@depth%d@100ms", bookDepth)
	params := make([]string, 0, len(symbols))
	for _, sym := range symbols {
		params = append(params, sym+depth)
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
