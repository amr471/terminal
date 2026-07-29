package aster

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/conn"
	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// tickersPath is the Binance-clone whole-market 24h ticker endpoint: called
// without a `symbol` param it returns an array covering every instrument.
// Aster mirrors Binance's `/fapi/v1/*` REST surface (package doc), which is
// why this reuses that path rather than a bespoke one.
//
// REST rather than the `!ticker@arr` ws stream Binance uses: that stream's
// availability on Aster is unverified, and a wrong stream name would fail the
// whole connection. The REST array is the same data at 15s granularity and
// costs no ws stream budget — see exchange.RESTTickerFeed.
const tickersPath = "/fapi/v1/ticker/24hr"

// tickerRow is one element of the 24hr ticker array. `priceChangePercent` is a
// PERCENT string ("-1.65"), so it converts to the fraction convention
// norm.Ticker.Change24h uses.
type tickerRow struct {
	Symbol      string `json:"symbol"`
	LastPrice   string `json:"lastPrice"`
	ChangePct   string `json:"priceChangePercent"`
	HighPrice   string `json:"highPrice"`
	LowPrice    string `json:"lowPrice"`
	Volume      string `json:"volume"`
	QuoteVolume string `json:"quoteVolume"`
	CloseTime   int64  `json:"closeTime"`
}

// NewTickerFeed builds Aster's venue-wide 24h ticker poller.
func NewTickerFeed(log *slog.Logger) conn.Feed {
	return exchange.NewRESTTickerFeed(exchangeName, exchangeName+".ticker.rest", restBase+tickersPath, parseTickers, log)
}

func parseTickers(body []byte) ([]exchange.TickerRow, error) {
	var rows []tickerRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("aster: decode tickers: %w", err)
	}
	out := make([]exchange.TickerRow, 0, len(rows))
	for _, r := range rows {
		if r.Symbol == "" || r.LastPrice == "" {
			continue
		}
		out = append(out, exchange.TickerRow{
			Symbol: norm.NormalizeSymbol(r.Symbol),
			TS:     r.CloseTime,
			Ticker: norm.Ticker{
				Last:           r.LastPrice,
				Volume24h:      r.Volume,
				QuoteVolume24h: r.QuoteVolume,
				Change24h:      pctToFraction(r.ChangePct),
				High24h:        r.HighPrice,
				Low24h:         r.LowPrice,
			},
		})
	}
	return out, nil
}

// pctToFraction converts a percent string ("-5.2") to the fraction convention
// ("-0.052"). Exact decimal division, never float64 (architecture.md §4.3);
// "" when unparseable so the field is omitted rather than written wrong.
func pctToFraction(pct string) string {
	if pct == "" {
		return ""
	}
	d, err := decimal.NewFromString(pct)
	if err != nil {
		return ""
	}
	return d.Div(decimal.NewFromInt(100)).String()
}
