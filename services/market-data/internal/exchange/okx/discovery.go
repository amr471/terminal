package okx

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/terminal/market-data/internal/exchange"
)

// StreamsPerSymbol: trades + funding-rate + open-interest + books5 + one
// candle channel per timeframe.
func (adapter) StreamsPerSymbol() int { return 4 + len(timeframes) }

// instrumentsResp is the subset of GET /api/v5/public/instruments?instType=SWAP.
type instrumentsResp struct {
	Data []struct {
		InstID   string `json:"instId"`
		State    string `json:"state"`
		SettleCy string `json:"settleCcy"`
	} `json:"data"`
}

// Instruments lists live USDT-settled perpetual swaps.
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var r instrumentsResp
	url := baseURL + "/api/v5/public/instruments?instType=SWAP"
	if err := exchange.FetchJSON(ctx, client, url, &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.Data))
	for _, s := range r.Data {
		if s.State == "live" && s.SettleCy == "USDT" && strings.HasSuffix(s.InstID, "-USDT-SWAP") {
			out = append(out, fromInstID(s.InstID))
		}
	}
	return out, nil
}
