package binance

import (
	"context"
	"net/http"
	"time"

	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// StreamsPerSymbol: aggTrade + markPrice + depth<N> + one kline per timeframe.
// The REST OI poller is a separate feed, not a ws stream, so it doesn't count
// against the ws connection's stream budget (P1.5c sharding).
func (adapter) StreamsPerSymbol() int { return 3 + len(timeframes) }

// exchangeInfo is the subset of GET /fapi/v1/exchangeInfo we filter on.
// (Aster uses the identical Binance-clone shape — see aster/discovery.go.)
type exchangeInfo struct {
	Symbols []struct {
		Symbol       string `json:"symbol"`
		ContractType string `json:"contractType"`
		Status       string `json:"status"`
		QuoteAsset   string `json:"quoteAsset"`
	} `json:"symbols"`
}

// Instruments lists live USDT-margined perpetuals from exchangeInfo.
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
