package okx

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// tickersPath is OKX's whole-market 24h ticker snapshot: every SWAP
// instrument's stats in one request. OKX has no all-market ticker WEBSOCKET
// channel — its `tickers` channel is per-instId, which would cost a stream per
// symbol against the connection budget that already forced sharding here, and
// would still only cover the capped symbol set. See exchange.RESTTickerFeed.
const tickersPath = "/api/v5/market/tickers?instType=SWAP"

// tickerRow is one element of the v5 tickers response `data` array. OKX gives
// `open24h` rather than a percent change, so change is computed below.
// `vol24h` is base-asset volume; `volCcy24h` is quote (USDT) volume.
type tickerRow struct {
	InstID    string `json:"instId"`
	Last      string `json:"last"`
	Open24h   string `json:"open24h"`
	High24h   string `json:"high24h"`
	Low24h    string `json:"low24h"`
	Vol24h    string `json:"vol24h"`
	VolCcy24h string `json:"volCcy24h"`
	TS        string `json:"ts"` // ms epoch as a STRING, OKX-style
}

type tickersResp struct {
	Code string      `json:"code"`
	Msg  string      `json:"msg"`
	Data []tickerRow `json:"data"`
}

// NewTickerFeed builds OKX's venue-wide 24h ticker poller.
func NewTickerFeed(log *slog.Logger) conn.Feed {
	return exchange.NewRESTTickerFeed(exchangeName, exchangeName+".ticker.rest", restBase+tickersPath, parseTickers, log)
}

// parseTickers converts one tickers response into normalized rows. Only
// USDT-quoted swaps are kept — the rest of this package is hardcoded to that
// universe (see instid.go), so admitting others here would produce symbols
// nothing else in the venue can subscribe or correlate.
func parseTickers(body []byte) ([]exchange.TickerRow, error) {
	var resp tickersResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("okx: decode tickers: %w", err)
	}
	// OKX signals application errors in the body with a non-"0" code and HTTP
	// 200, so a status check alone would let a rate-limit reply through as an
	// empty (and therefore silently universe-clearing) result.
	if resp.Code != "" && resp.Code != "0" {
		return nil, fmt.Errorf("okx: tickers code %s: %s", resp.Code, resp.Msg)
	}
	out := make([]exchange.TickerRow, 0, len(resp.Data))
	for _, r := range resp.Data {
		if r.InstID == "" || r.Last == "" {
			continue
		}
		symbol := fromInstID(r.InstID)
		if _, ok := toInstID(symbol); !ok {
			continue // not a USDT swap (round-trip check)
		}
		out = append(out, exchange.TickerRow{
			Symbol: symbol,
			TS:     parseMsString(r.TS),
			Ticker: norm.Ticker{
				Last:           r.Last,
				Volume24h:      r.Vol24h,
				QuoteVolume24h: r.VolCcy24h,
				Change24h:      changeFraction(r.Last, r.Open24h),
				High24h:        r.High24h,
				Low24h:         r.Low24h,
			},
		})
	}
	return out, nil
}

// changeFraction computes (last-open)/open as the FRACTION convention
// norm.Ticker.Change24h uses. Exact decimal division, never float64
// (architecture.md §4.3); "" when either side is unusable or open is zero, so
// the field is omitted rather than written as a wrong or infinite number.
func changeFraction(last, open string) string {
	if last == "" || open == "" {
		return ""
	}
	l, err1 := decimal.NewFromString(last)
	o, err2 := decimal.NewFromString(open)
	if err1 != nil || err2 != nil || o.IsZero() {
		return ""
	}
	// 12 dp is far finer than any percent display needs and keeps the string
	// bounded; DivRound avoids the panic Div can raise on non-terminating
	// quotients.
	return l.Sub(o).DivRound(o, 12).String()
}

func parseMsString(s string) int64 {
	if s == "" {
		return 0
	}
	d, err := decimal.NewFromString(s)
	if err != nil {
		return 0
	}
	return d.IntPart()
}
