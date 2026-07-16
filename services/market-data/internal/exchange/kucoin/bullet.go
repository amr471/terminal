package kucoin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// bullet is the connection info returned by the bullet-public handshake: the
// ws endpoint to dial, the token to append, and KuCoin's recommended ping
// cadence (all needed before a single frame can flow — package doc).
type bullet struct {
	endpoint     string
	token        string
	pingInterval time.Duration
}

// bulletResponse mirrors POST /api/v1/bullet-public. We take the first
// instance server (KuCoin returns one for public data).
type bulletResponse struct {
	Code string `json:"code"`
	Data struct {
		Token           string `json:"token"`
		InstanceServers []struct {
			Endpoint     string `json:"endpoint"`
			PingInterval int    `json:"pingInterval"` // ms
		} `json:"instanceServers"`
	} `json:"data"`
}

// fetchBullet performs the REST handshake. Split out (and taking baseURL +
// client) so it's testable against an httptest server without a live network,
// matching the package's decode tests.
func fetchBullet(ctx context.Context, client *http.Client, baseURL string) (bullet, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+bulletPath, nil)
	if err != nil {
		return bullet{}, fmt.Errorf("kucoin: bullet request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return bullet{}, fmt.Errorf("kucoin: bullet POST: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return bullet{}, fmt.Errorf("kucoin: bullet read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return bullet{}, fmt.Errorf("kucoin: bullet status %d: %s", resp.StatusCode, body)
	}
	return parseBullet(body)
}

func parseBullet(body []byte) (bullet, error) {
	var r bulletResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return bullet{}, fmt.Errorf("kucoin: bullet decode: %w", err)
	}
	if r.Data.Token == "" || len(r.Data.InstanceServers) == 0 {
		return bullet{}, fmt.Errorf("kucoin: bullet missing token/servers (code %q)", r.Code)
	}
	srv := r.Data.InstanceServers[0]
	if srv.Endpoint == "" {
		return bullet{}, fmt.Errorf("kucoin: bullet empty endpoint")
	}
	ping := time.Duration(srv.PingInterval) * time.Millisecond
	if ping <= 0 {
		ping = 18 * time.Second // KuCoin's documented default
	}
	return bullet{endpoint: srv.Endpoint, token: r.Data.Token, pingInterval: ping}, nil
}

// dialURL is the ws URL to connect: the bullet endpoint with token +
// connectId query params (KuCoin requires both).
func (b bullet) dialURL(connectID string) string {
	sep := "?"
	if containsQuery(b.endpoint) {
		sep = "&"
	}
	return b.endpoint + sep + "token=" + b.token + "&connectId=" + connectID
}

func containsQuery(u string) bool {
	for i := 0; i < len(u); i++ {
		if u[i] == '?' {
			return true
		}
	}
	return false
}
