package hyperliquid

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// StreamsPerSymbol: trades + l2Book + activeAssetCtx + one candle per tf.
// (HL's Limits.MaxStreamsPerConn is 0 — one connection — so this only matters
// if a per-connection cap is added later.)
func (adapter) StreamsPerSymbol() int { return 3 + len(timeframes) }

// metaResp is the subset of POST /info {"type":"meta"} — the perp universe.
type metaResp struct {
	Universe []struct {
		Name       string `json:"name"`
		IsDelisted bool   `json:"isDelisted"`
	} `json:"universe"`
}

// Instruments lists HyperLiquid's live perp coins, mapped to our USDT-quoted
// normalized symbols (BTC -> btcusdt). VERIFY the isDelisted field name.
func (adapter) Instruments(ctx context.Context) ([]string, error) {
	return fetchInstruments(ctx, &http.Client{Timeout: 10 * time.Second}, infoURL)
}

func fetchInstruments(ctx context.Context, client *http.Client, url string) ([]string, error) {
	body, _ := json.Marshal(map[string]string{"type": "meta"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("hyperliquid: build meta request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("hyperliquid: POST meta: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("hyperliquid: read meta: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hyperliquid: meta status %d", resp.StatusCode)
	}
	var m metaResp
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("hyperliquid: decode meta: %w", err)
	}
	out := make([]string, 0, len(m.Universe))
	for _, u := range m.Universe {
		if u.IsDelisted || u.Name == "" {
			continue
		}
		out = append(out, symbolFor(u.Name))
	}
	return out, nil
}
