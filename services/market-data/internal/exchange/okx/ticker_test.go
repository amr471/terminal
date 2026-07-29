package okx

import "testing"

func TestParseTickers(t *testing.T) {
	// Real v5 /market/tickers?instType=SWAP shape: string `ts`, `open24h`
	// instead of a percent change, vol24h (base) + volCcy24h (quote).
	body := []byte(`{"code":"0","msg":"","data":[
	  {"instId":"BTC-USDT-SWAP","last":"63849.4","open24h":"64980.0","high24h":"65100.0",
	   "low24h":"63000.0","vol24h":"120000","volCcy24h":"7600000000","ts":"1785263923377"},
	  {"instId":"ETH-USDT-SWAP","last":"1920.37","open24h":"1920.37","high24h":"1990",
	   "low24h":"1900","vol24h":"50000","volCcy24h":"96000000","ts":"1785263923377"},
	  {"instId":"BTC-USD-SWAP","last":"63849.4","open24h":"64000","vol24h":"1","volCcy24h":"2","ts":"1"}
	]}`)

	rows, err := parseTickers(body)
	if err != nil {
		t.Fatal(err)
	}
	// The coin-margined BTC-USD swap must be skipped: this package only handles
	// USDT swaps, and emitting "btcusd" would produce a symbol nothing else in
	// the venue can subscribe or correlate.
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2 (BTC-USD-SWAP must be skipped): %+v", len(rows), rows)
	}
	btc := rows[0]
	if btc.Symbol != "btcusdt" {
		t.Errorf("symbol = %q, want btcusdt", btc.Symbol)
	}
	if btc.TS != 1785263923377 {
		t.Errorf("ts = %d (string ms must be parsed)", btc.TS)
	}
	if btc.Ticker.Last != "63849.4" || btc.Ticker.QuoteVolume24h != "7600000000" {
		t.Errorf("ticker = %+v", btc.Ticker)
	}
	// (63849.4 - 64980) / 64980 = -0.0174... as a FRACTION, not a percent.
	if got := btc.Ticker.Change24h; got == "" || got[0] != '-' {
		t.Errorf("change24h = %q, want a negative fraction", got)
	}
	// Flat price must be exactly zero change, not empty or a rounding artifact.
	if got := rows[1].Ticker.Change24h; got != "0" {
		t.Errorf("eth change24h = %q, want 0", got)
	}
}

func TestParseTickersRejectsErrorBody(t *testing.T) {
	// OKX returns application errors with HTTP 200 and a non-"0" code. Treating
	// that as an empty result would silently clear the venue's whole universe.
	if _, err := parseTickers([]byte(`{"code":"50011","msg":"rate limit","data":[]}`)); err == nil {
		t.Fatal("want an error for a non-zero OKX code")
	}
	if _, err := parseTickers([]byte(`not json`)); err == nil {
		t.Fatal("want an error for a malformed body")
	}
}

func TestChangeFractionGuards(t *testing.T) {
	if got := changeFraction("100", "0"); got != "" {
		t.Errorf("divide by zero open = %q, want empty", got)
	}
	if got := changeFraction("", "100"); got != "" {
		t.Errorf("empty last = %q, want empty", got)
	}
	if got := changeFraction("abc", "100"); got != "" {
		t.Errorf("unparseable = %q, want empty", got)
	}
	if got := changeFraction("110", "100"); got != "0.1" {
		t.Errorf("changeFraction(110,100) = %q, want 0.1", got)
	}
}
