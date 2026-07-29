package binance

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/shopspring/decimal"

	"github.com/terminal/market-data/internal/exchange"
	"github.com/terminal/market-data/internal/norm"
)

// StreamsPerSymbol: aggTrade + markPrice + one kline per timeframe — the
// per-symbol cost of WSFeed's /market connection. depth<N> moved to its own
// /public connection (DepthFeed) at the 2026-07-17 routing split (package
// doc, binance.go) and is no longer counted here: shard sizing uses this
// number for both feeds' shards, and WSFeed's per-symbol cost (2+len(tf)) is
// higher than DepthFeed's (1), so sizing to the larger number keeps both
// connections under Limits().MaxStreamsPerConn. The REST OI poller is a
// separate feed, not a ws stream, so it doesn't count against either budget.
func (adapter) StreamsPerSymbol() int { return 2 + len(timeframes) }

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

// ticker24h is the subset of GET /fapi/v1/ticker/24hr (array form: every
// symbol's rolling 24h stats in one request, weight 40).
type ticker24h struct {
	Symbol      string  `json:"symbol"`
	QuoteVolume flexStr `json:"quoteVolume"`
}

// RankByVolume orders symbols by 24h QUOTE volume, descending — see
// exchange.VolumeRanker for why the cap must not be alphabetical. Symbols the
// venue didn't report keep their relative order at the end (never dropped);
// ranking is a preference, not a filter.
func (adapter) RankByVolume(ctx context.Context, symbols []string) ([]string, error) {
	return rankByVolume(ctx, &http.Client{Timeout: 10 * time.Second}, restBase, symbols)
}

func rankByVolume(ctx context.Context, client *http.Client, baseURL string, symbols []string) ([]string, error) {
	var tickers []ticker24h
	if err := exchange.FetchJSON(ctx, client, baseURL+"/fapi/v1/ticker/24hr", &tickers); err != nil {
		return nil, err
	}
	vol := make(map[string]decimal.Decimal, len(tickers))
	for _, t := range tickers {
		// Parse as decimal, never float64 (architecture.md §4.3). A malformed
		// or absent volume simply leaves the symbol unranked.
		if d, err := decimal.NewFromString(string(t.QuoteVolume)); err == nil {
			vol[norm.NormalizeSymbol(t.Symbol)] = d
		}
	}
	ranked := make([]string, 0, len(symbols))
	unranked := make([]string, 0)
	for _, s := range symbols {
		if _, ok := vol[s]; ok {
			ranked = append(ranked, s)
		} else {
			unranked = append(unranked, s)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		c := vol[ranked[i]].Cmp(vol[ranked[j]])
		if c != 0 {
			return c > 0 // higher volume first
		}
		return ranked[i] < ranked[j] // stable, deterministic tie-break
	})
	return append(ranked, unranked...), nil
}

func fetchInstruments(ctx context.Context, client *http.Client, baseURL string) ([]string, error) {
	var info exchangeInfo
	if err := exchange.FetchJSON(ctx, client, baseURL+"/fapi/v1/exchangeInfo", &info); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(info.Symbols))
	for _, s := range info.Symbols {
		if s.ContractType != "PERPETUAL" || s.Status != "TRADING" {
			continue
		}
		// USDC admitted alongside USDT since 2026-07-26. Binance lists real
		// USDC-quoted perps (btcusdc, ethusdc) and the all-market ticker already
		// reported them, so they showed price and volume — but they were absent
		// from this universe, so they never got the per-symbol feeds and their
		// funding/OI cells stayed permanently blank. Admitting them here closes
		// that gap. Other quotes stay out deliberately: this repo's screener and
		// cross-venue correlation assume a stablecoin quote.
		if s.QuoteAsset != "USDT" && s.QuoteAsset != "USDC" {
			continue
		}
		out = append(out, norm.NormalizeSymbol(s.Symbol))
	}
	return out, nil
}
