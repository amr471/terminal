package bingx

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// StreamsPerSymbol: trade + depth + one kline per tf (funding/OI scoped out).
func (adapter) StreamsPerSymbol() int { return 2 + len(timeframes) }

// contractsResp is the subset of GET /openApi/swap/v2/quote/contracts.
// status 1 = the contract is online/tradable. VERIFY the field name/value.
type contractsResp struct {
	Data []struct {
		Symbol string `json:"symbol"`
		Status int    `json:"status"`
	} `json:"data"`
}

// Instruments lists live USDT perpetuals (symbols like "BTC-USDT").
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var r contractsResp
	if err := exchange.FetchJSON(ctx, client, baseURL+"/openApi/swap/v2/quote/contracts", &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.Data))
	for _, c := range r.Data {
		if c.Status == 1 && strings.HasSuffix(c.Symbol, "-USDT") {
			out = append(out, norm.NormalizeSymbol(c.Symbol))
		}
	}
	return out, nil
}
