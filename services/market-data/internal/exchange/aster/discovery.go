package aster

import (
	"context"
	"net/http"
	"time"

	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// StreamsPerSymbol: aggTrade + markPrice + depth<N> + one kline per timeframe
// (the REST OI poller is a separate feed, not a ws stream).
func (adapter) StreamsPerSymbol() int { return 3 + len(timeframes) }

// exchangeInfo mirrors Aster's Binance-clone GET /fapi/v1/exchangeInfo.
type exchangeInfo struct {
	Symbols []struct {
		Symbol       string `json:"symbol"`
		ContractType string `json:"contractType"`
		Status       string `json:"status"`
		QuoteAsset   string `json:"quoteAsset"`
	} `json:"symbols"`
}

// Instruments lists live USDT-margined perpetuals. VERIFY Aster's
// exchangeInfo field names match Binance's (they should — it's a clone).
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var info exchangeInfo
	if err := exchange.FetchJSON(ctx, client, baseURL+"/fapi/v1/exchangeInfo", &info); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(info.Symbols))
	for _, s := range info.Symbols {
		if s.ContractType == "PERPETUAL" && s.Status == "TRADING" && s.QuoteAsset == "USDT" {
			out = append(out, norm.NormalizeSymbol(s.Symbol))
		}
	}
	return out, nil
}
