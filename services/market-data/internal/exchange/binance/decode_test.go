package binance

import "testing"

func TestDecodePartialDepthSnapshot(t *testing.T) {
	raw := []byte(`{"e":"depthUpdate","E":1783793088123,"T":1783793088100,"s":"BTCUSDT","U":1,"u":5,"pu":0,"b":[["64000.0","1.2"],["63999.0","0.5"]],"a":[["64001.0","0.8"]]}`)
	symbol, ts, book, err := decodePartialDepth(raw)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1783793088123 || !book.Snapshot {
		t.Fatalf("depth = %s %d snapshot=%v", symbol, ts, book.Snapshot)
	}
	if len(book.Bids) != 2 || book.Bids[0][0] != "64000.0" || book.Bids[0][1] != "1.2" {
		t.Fatalf("bids = %v", book.Bids)
	}
	if len(book.Asks) != 1 || book.Asks[0][0] != "64001.0" {
		t.Fatalf("asks = %v", book.Asks)
	}
}

func TestDepthSubscribeParams(t *testing.T) {
	p := depthSubscribeParams([]string{"btcusdt", "ethusdt"})
	if len(p) != 2 {
		t.Fatalf("params = %d, want 2: %v", len(p), p)
	}
	if p[0] != "btcusdt@depth20@100ms" || p[1] != "ethusdt@depth20@100ms" {
		t.Fatalf("params = %v", p)
	}
}

func TestDecodeAggTrade(t *testing.T) {
	raw := []byte(`{"e":"aggTrade","E":1783793088123,"s":"BTCUSDT","p":"64123.50","q":"0.015","f":100,"l":105,"T":1783793088100,"m":true,"a":5000}`)
	symbol, ts, trade, err := decodeAggTrade(raw)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" {
		t.Errorf("symbol = %q, want btcusdt", symbol)
	}
	if ts != 1783793088123 {
		t.Errorf("ts = %d, want event time", ts)
	}
	if trade.Price != "64123.50" || trade.Qty != "0.015" {
		t.Errorf("trade = %+v", trade)
	}
	if trade.Side != "sell" { // m=true (buyer is maker) => taker sold
		t.Errorf("side = %q, want sell", trade.Side)
	}
}

func TestDecodeAggTrade_BuyerIsTaker(t *testing.T) {
	raw := []byte(`{"e":"aggTrade","E":1,"s":"ETHUSDT","p":"3450.10","q":"1","m":false,"a":1}`)
	_, _, trade, err := decodeAggTrade(raw)
	if err != nil {
		t.Fatal(err)
	}
	if trade.Side != "buy" {
		t.Errorf("side = %q, want buy", trade.Side)
	}
}

func TestDecodeKline(t *testing.T) {
	raw := []byte(`{"e":"kline","E":1783793088123,"s":"BTCUSDT","k":{"t":1783793040000,"T":1783793099999,"s":"BTCUSDT","i":"1m","o":"64100.00","c":"64123.50","h":"64150.00","l":"64090.00","v":"12.5","n":340,"x":true,"q":"801500.25"}}`)
	symbol, ts, candle, err := decodeKline(raw)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1783793088123 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	if candle.TF != "1m" || !candle.Final || candle.Close != "64123.50" || candle.TradeCount != 340 {
		t.Errorf("candle = %+v", candle)
	}
}

func TestDecodeKline_UnclosedBucketNotFinal(t *testing.T) {
	raw := []byte(`{"e":"kline","E":1,"s":"BTCUSDT","k":{"i":"1m","o":"1","h":"1","l":"1","c":"1","v":"1","x":false}}`)
	_, _, candle, err := decodeKline(raw)
	if err != nil {
		t.Fatal(err)
	}
	if candle.Final {
		t.Error("expected Final=false for an in-progress bucket")
	}
}

func TestDecodeMarkPrice(t *testing.T) {
	raw := []byte(`{"e":"markPriceUpdate","E":1783793088123,"s":"BTCUSDT","p":"64125.00","i":"64120.00","r":"0.00010","T":1783822800000}`)
	symbol, ts, funding, err := decodeMarkPrice(raw)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1783793088123 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	if funding.Rate != "0.00010" || funding.NextFundingTS != 1783822800000 {
		t.Errorf("funding = %+v", funding)
	}
}

func TestClassify_UnknownFrameIsNotAnError_ButHasNoEvent(t *testing.T) {
	// Subscription ack frames look like {"result":null,"id":1} — no "e" field.
	_, err := classify([]byte(`{"result":null,"id":1}`))
	if err == nil {
		t.Fatal("expected an error for a frame with no event type")
	}
}

func TestMarketSubscribeParams_CoversAllChannelsPerSymbol(t *testing.T) {
	params := marketSubscribeParams([]string{"btcusdt", "ethusdt"})
	want := len(timeframes) + 2 // aggTrade + markPrice + N klines, per symbol (depth moved to depthSubscribeParams)
	if len(params) != want*2 {
		t.Fatalf("len(params) = %d, want %d", len(params), want*2)
	}
	has := func(s string) bool {
		for _, p := range params {
			if p == s {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"btcusdt@aggTrade", "btcusdt@markPrice", "btcusdt@kline_1m", "btcusdt@kline_1d", "ethusdt@aggTrade"} {
		if !has(want) {
			t.Errorf("missing subscribe param %q", want)
		}
	}
	if has("btcusdt@depth20@100ms") {
		t.Error("depth stream should not be in marketSubscribeParams — it moved to depthSubscribeParams (/public route)")
	}
}

// Real bug from a live run 2026-07-26: Binance pushes some kline OHLCV fields
// as bare JSON numbers rather than quoted strings, which failed the whole
// message ("cannot unmarshal number into Go struct field .k.l of type string")
// and discarded every candle for that symbol.
func TestDecodeKlineAcceptsNumbersOrStrings(t *testing.T) {
	// "l" and "v" unquoted; the rest quoted — the mixed shape actually seen.
	raw := []byte(`{"e":"kline","E":1783793088123,"s":"BTCUSDT","k":{
		"i":"1m","o":"64000.1","h":"64100.2","l":63900.3,"c":"64050.4",
		"v":12.5,"q":"800000","n":42,"x":true}}`)
	symbol, ts, candle, err := decodeKline(raw)
	if err != nil {
		t.Fatalf("decodeKline should accept unquoted numbers: %v", err)
	}
	if symbol != "btcusdt" || ts != 1783793088123 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	// Digits must survive exactly — never round-tripped through float64.
	if candle.Low != "63900.3" || candle.Volume != "12.5" {
		t.Errorf("low/volume = %q/%q, want 63900.3/12.5", candle.Low, candle.Volume)
	}
	if candle.Open != "64000.1" || candle.Close != "64050.4" || candle.QuoteVolume != "800000" {
		t.Errorf("quoted fields regressed: %+v", candle)
	}
	if !candle.Final || candle.TradeCount != 42 || candle.TF != "1m" {
		t.Errorf("candle = %+v", candle)
	}
}

func TestDecodeAllTickers(t *testing.T) {
	// A real `!ticker@arr` frame shape: a JSON array of 24hrTicker objects.
	raw := []byte(`[
      {"e":"24hrTicker","E":1783793088123,"s":"BTCUSDT","P":"-5.2","c":"64000.5","h":"66000","l":"63000","v":"1234.5","q":"78900000"},
      {"e":"24hrTicker","E":1783793088123,"s":"ETHUSDT","P":"3.75","c":"3200.1","h":"3300","l":"3100","v":"9876","q":"31000000"}
    ]`)
	got, ok := decodeAllTickers(raw, nil)
	if !ok {
		t.Fatal("decodeAllTickers returned ok=false for a valid array frame")
	}
	if len(got) != 2 {
		t.Fatalf("got %d tickers, want 2", len(got))
	}
	btc := got[0]
	if btc.symbol != "btcusdt" {
		t.Errorf("symbol = %q, want btcusdt (normalized)", btc.symbol)
	}
	if btc.ts != 1783793088123 {
		t.Errorf("ts = %d", btc.ts)
	}
	if btc.ticker.Last != "64000.5" || btc.ticker.Volume24h != "1234.5" {
		t.Errorf("last/volume = %q/%q", btc.ticker.Last, btc.ticker.Volume24h)
	}
	if btc.ticker.QuoteVolume24h != "78900000" {
		t.Errorf("quoteVolume = %q", btc.ticker.QuoteVolume24h)
	}
	// "P" is a percent; norm.Ticker.Change24h is a fraction.
	if btc.ticker.Change24h != "-0.052" {
		t.Errorf("change24h = %q, want -0.052 (percent converted to fraction)", btc.ticker.Change24h)
	}
	if got[1].ticker.Change24h != "0.0375" {
		t.Errorf("eth change24h = %q, want 0.0375", got[1].ticker.Change24h)
	}
}

// Real bug 2026-07-26: prices showed as 1,785,263,923,377 (a ms timestamp) for
// nearly every Binance row. 24hrTicker carries BOTH `c` (last price) and `C`
// (stats close time); with no field tagged `C`, encoding/json's
// case-insensitive fallback folded `C` onto `c` and — arriving later in the
// object — overwrote the price. This uses Binance's REAL full field set and
// real key order so the collision is actually exercised.
func TestDecodeAllTickersFullShape_NoCaseFoldingCollision(t *testing.T) {
	raw := []byte(`[{"e":"24hrTicker","E":1785263923377,"s":"BTCUSDT",
      "p":"-1070.00","P":"-1.65","w":"64500.00","c":"63726.20","Q":"0.005",
      "o":"64796.20","h":"65000.00","l":"63000.00","v":"163000.5","q":"10407203485.89",
      "O":1785177523377,"C":1785263923377,"F":100,"L":200,"n":101}]`)
	got, ok := decodeAllTickers(raw, nil)
	if !ok || len(got) != 1 {
		t.Fatalf("ok=%v len=%d", ok, len(got))
	}
	tk := got[0].ticker
	if tk.Last != "63726.20" {
		t.Errorf("last = %q, want 63726.20 — `C` (stats close time) must not fold onto `c`", tk.Last)
	}
	if tk.Low24h != "63000.00" {
		t.Errorf("low = %q, want 63000.00 — `L` (last trade id) must not fold onto `l`", tk.Low24h)
	}
	if tk.QuoteVolume24h != "10407203485.89" {
		t.Errorf("quoteVolume = %q — `Q` (last qty) must not fold onto `q`", tk.QuoteVolume24h)
	}
	if tk.Volume24h != "163000.5" {
		t.Errorf("volume = %q, want 163000.5", tk.Volume24h)
	}
	if tk.Change24h != "-0.0165" {
		t.Errorf("change = %q, want -0.0165 — `p` must not fold onto `P`", tk.Change24h)
	}
}

// Same collision class inside the kline "k" object: `V`/`Q` (taker-buy volumes)
// arrive AFTER `v`/`q` (totals), so before the fix they silently replaced the
// totals — every stored candle's volume was really the taker-buy share.
func TestDecodeKlineFullShape_TakerVolumesDoNotOverwriteTotals(t *testing.T) {
	raw := []byte(`{"e":"kline","E":1785263923377,"s":"BTCUSDT","k":{
      "t":1785263900000,"T":1785263959999,"s":"BTCUSDT","i":"1m","f":100,"L":200,
      "o":"64000.1","c":"64050.4","h":"64100.2","l":"63900.3",
      "v":"1000","n":42,"x":true,"q":"64000000","V":"400","Q":"25600000","B":"0"}}`)
	_, _, candle, err := decodeKline(raw)
	if err != nil {
		t.Fatal(err)
	}
	if candle.Volume != "1000" {
		t.Errorf("volume = %q, want the TOTAL 1000 — `V` (taker-buy) must not fold onto `v`", candle.Volume)
	}
	if candle.QuoteVolume != "64000000" {
		t.Errorf("quoteVolume = %q, want the TOTAL — `Q` must not fold onto `q`", candle.QuoteVolume)
	}
	if candle.Low != "63900.3" {
		t.Errorf("low = %q — `L` (last trade id) must not fold onto `l`", candle.Low)
	}
}

func TestDecodeAllTickersIgnoresNonArrayFrames(t *testing.T) {
	// The subscribe ack is an object, not an array — normal traffic, must not
	// be treated as a decode failure.
	if _, ok := decodeAllTickers([]byte(`{"result":null,"id":1}`), nil); ok {
		t.Error("subscribe ack should return ok=false")
	}
	if _, ok := decodeAllTickers([]byte(`not json`), nil); ok {
		t.Error("garbage should return ok=false")
	}
}

func TestDecodeAllTickersSkipsMalformedEntries(t *testing.T) {
	// One unusable entry must not cost us the rest of the frame.
	raw := []byte(`[
      {"e":"24hrTicker","E":1,"s":"","c":"1"},
      {"e":"24hrTicker","E":1,"s":"BTCUSDT","c":""},
      {"e":"24hrTicker","E":1,"s":"ETHUSDT","P":"bogus","c":"3200","v":"1","q":"2"}
    ]`)
	got, ok := decodeAllTickers(raw, nil)
	if !ok {
		t.Fatal("ok=false")
	}
	if len(got) != 1 || got[0].symbol != "ethusdt" {
		t.Fatalf("got %+v, want just ethusdt", got)
	}
	// An unparseable percent is omitted rather than written as a wrong number.
	if got[0].ticker.Change24h != "" {
		t.Errorf("change24h = %q, want empty for a bogus percent", got[0].ticker.Change24h)
	}
}

func TestChunkParams(t *testing.T) {
	// A ~100-symbol shard is ~800 params (8/symbol) — the case that 1008s as
	// one frame. Chunking at maxParamsPerSubscribe must keep every batch small,
	// lose nothing, and preserve order.
	params := marketSubscribeParams(makeSymbols(100))
	batches := chunkParams(params, maxParamsPerSubscribe)

	var flat []string
	for _, b := range batches {
		if len(b) > maxParamsPerSubscribe {
			t.Fatalf("batch of %d exceeds cap %d", len(b), maxParamsPerSubscribe)
		}
		flat = append(flat, b...)
	}
	if len(flat) != len(params) {
		t.Fatalf("chunking lost params: got %d, want %d", len(flat), len(params))
	}
	for i := range params {
		if flat[i] != params[i] {
			t.Fatalf("order not preserved at %d: %q vs %q", i, flat[i], params[i])
		}
	}
	// ceil(len/cap) batches, each ≤ the proven-good 96-param depth frame size.
	wantBatches := (len(params) + maxParamsPerSubscribe - 1) / maxParamsPerSubscribe
	if len(batches) != wantBatches {
		t.Fatalf("batches = %d, want %d", len(batches), wantBatches)
	}
	if maxParamsPerSubscribe > 96 {
		t.Fatalf("maxParamsPerSubscribe %d exceeds the known-good 96-param frame", maxParamsPerSubscribe)
	}

	// Small sets and empty/zero size collapse to a single batch.
	if got := chunkParams([]string{"a", "b"}, maxParamsPerSubscribe); len(got) != 1 {
		t.Fatalf("small set: %d batches, want 1", len(got))
	}
	if got := chunkParams(params, 0); len(got) != 1 {
		t.Fatalf("size 0: %d batches, want 1", len(got))
	}
}

func makeSymbols(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = "sym" + itoa(i) + "usdt"
	}
	return out
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
