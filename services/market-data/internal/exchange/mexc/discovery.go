package mexc

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/terminal/market-data/internal/exchange"
)

// StreamsPerSymbol: deal + funding.rate + one kline per tf (book/OI scoped out).
func (adapter) StreamsPerSymbol() int { return 2 + len(timeframes) }

// contractDetail is the subset of GET /api/v1/contract/detail. state 0 = the
// contract is enabled/tradable (MEXC: 0 enabled, 3 offline, 4 paused, ...).
type contractDetail struct {
	Data []struct {
		Symbol    string `json:"symbol"`
		QuoteCoin string `json:"quoteCoin"`
		State     int    `json:"state"`
	} `json:"data"`
}

// Instruments lists live USDT perpetuals (symbols like "BTC_USDT").
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var r contractDetail
	if err := exchange.FetchJSON(ctx, client, baseURL+"/api/v1/contract/detail", &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.Data))
	for _, c := range r.Data {
		if c.State == 0 && c.QuoteCoin == "USDT" && strings.HasSuffix(c.Symbol, "_USDT") {
			out = append(out, symbolFromWire(c.Symbol))
		}
	}
	return out, nil
}
