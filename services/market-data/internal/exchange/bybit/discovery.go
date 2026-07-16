package bybit

import (
	"context"
	"net/http"
	"time"

	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// StreamsPerSymbol: publicTrade + tickers + orderbook + one kline per tf.
func (adapter) StreamsPerSymbol() int { return 3 + len(timeframes) }

// instrumentsInfo is the subset of GET /v5/market/instruments-info?category=linear.
type instrumentsInfo struct {
	Result struct {
		List []struct {
			Symbol       string `json:"symbol"`
			ContractType string `json:"contractType"`
			Status       string `json:"status"`
			QuoteCoin    string `json:"quoteCoin"`
		} `json:"list"`
	} `json:"result"`
}

// Instruments lists live USDT linear perpetuals.
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, restBase)
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var info instrumentsInfo
	url := baseURL + "/v5/market/instruments-info?category=linear&limit=1000"
	if err := exchange.FetchJSON(ctx, client, url, &info); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(info.Result.List))
	for _, s := range info.Result.List {
		if s.Status == "Trading" && s.QuoteCoin == "USDT" && s.ContractType == "LinearPerpetual" {
			out = append(out, norm.NormalizeSymbol(s.Symbol))
		}
	}
	return out, nil
}
