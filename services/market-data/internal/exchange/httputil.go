package exchange

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// fetchBytes does a GET and returns the raw body, same bounded-read and
// non-200 handling as FetchJSON. Used by RESTTickerFeed, which hands the body
// to a venue-supplied parser rather than a fixed struct (each venue's
// all-tickers response has a different shape).
func fetchBytes(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("exchange: build request %s: %w", url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange: GET %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("exchange: read %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("exchange: GET %s: status %d", url, resp.StatusCode)
	}
	return body, nil
}

// FetchJSON does a GET and decodes the JSON body into v. Shared by venue
// Instruments() implementations (P1.5c discovery). Bounded body read; a
// non-200 is an error the supervisor retries on the next cycle.
func FetchJSON(ctx context.Context, client *http.Client, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("exchange: build request %s: %w", url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("exchange: GET %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("exchange: read %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("exchange: GET %s: status %d", url, resp.StatusCode)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("exchange: decode %s: %w", url, err)
	}
	return nil
}
