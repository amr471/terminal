package kucoin

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/terminal/market-data/internal/exchange"
)

// StreamsPerSymbol: execution + level2Depth50 + contract/instrument + one
// limitCandle per tf.
func (adapter) StreamsPerSymbol() int { return 3 + len(timeframes) }

// contractsResp is the subset of GET /api/v1/contracts/active.
type contractsResp struct {
	Data []struct {
		Symbol        string `json:"symbol"`
		Status        string `json:"status"`
		QuoteCurrency string `json:"quoteCurrency"`
	} `json:"data"`
}

// Instruments lists live USDT-margined perpetuals (symbols ending "USDTM").
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var r contractsResp
	if err := exchange.FetchJSON(ctx, client, baseURL+"/api/v1/contracts/active", &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.Data))
	for _, c := range r.Data {
		if c.Status == "Open" && c.QuoteCurrency == "USDT" && strings.HasSuffix(c.Symbol, "USDTM") {
			out = append(out, symbolFromWire(c.Symbol))
		}
	}
	return out, nil
}
