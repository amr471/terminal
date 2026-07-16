package bybit

import "testing"

func TestClassify_Trade(t *testing.T) {
	kind, parts, _, ok, err := classify([]byte(`{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1,"data":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || kind != "publicTrade" || len(parts) != 1 || parts[0] != "BTCUSDT" {
		t.Fatalf("kind=%q parts=%v ok=%v", kind, parts, ok)
	}
}

func TestClassify_NonTopicFrameIsIgnorable(t *testing.T) {
	_, _, _, ok, err := classify([]byte(`{"success":true,"op":"pong"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected ok=false for a non-topic frame")
	}
}

func TestDecodeTrades(t *testing.T) {
	_, _, env, ok, err := classify([]byte(`{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1,"data":[
		{"T":1783793088100,"s":"BTCUSDT","S":"Sell","v":"0.5","p":"64123.50","i":"abc"}
	]}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	trades, err := decodeTrades(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 1 {
		t.Fatalf("len = %d, want 1", len(trades))
	}
	tr := trades[0]
	if tr.Symbol != "btcusdt" || tr.Trade.Side != "sell" || tr.Trade.Price != "64123.50" {
		t.Errorf("trade = %+v", tr)
	}
}

func TestDecodeTrades_BuySide(t *testing.T) {
	_, _, env, _, _ := classify([]byte(`{"topic":"publicTrade.ETHUSDT","ts":1,"data":[{"T":1,"s":"ETHUSDT","S":"Buy","v":"1","p":"3450.10","i":"x"}]}`))
	trades, err := decodeTrades(env)
	if err != nil {
		t.Fatal(err)
	}
	if trades[0].Trade.Side != "buy" {
		t.Errorf("side = %q, want buy", trades[0].Trade.Side)
	}
}

func TestDecodeKlines(t *testing.T) {
	kind, parts, env, ok, err := classify([]byte(`{"topic":"kline.5.BTCUSDT","ts":1,"data":[
		{"start":1783793040000,"interval":"5","open":"100","high":"110","low":"95","close":"105","volume":"12.5","turnover":"1300","confirm":true}
	]}`))
	if err != nil || !ok || kind != "kline" {
		t.Fatal(kind, err, ok)
	}
	symbol, tf, klines, err := decodeKlines(parts, env)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || tf != "5m" {
		t.Fatalf("symbol/tf = %q/%q", symbol, tf)
	}
	if len(klines) != 1 || !klines[0].Candle.Final || klines[0].Candle.Close != "105" {
		t.Errorf("klines = %+v", klines)
	}
}

func TestDecodeKlines_UnknownIntervalErrors(t *testing.T) {
	_, parts, env, _, _ := classify([]byte(`{"topic":"kline.999.BTCUSDT","ts":1,"data":[]}`))
	if _, _, _, err := decodeKlines(parts, env); err == nil {
		t.Fatal("expected an error for an unmapped interval code")
	}
}

func TestDecodeTicker_FundingAndOIBothPresent(t *testing.T) {
	_, parts, env, ok, err := classify([]byte(`{"topic":"tickers.BTCUSDT","ts":1000,"data":{
		"symbol":"BTCUSDT","fundingRate":"0.0001","nextFundingTime":"1783822800000",
		"openInterest":"850000000","openInterestValue":"5.44e10"
	}}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	symbol, ts, funding, oi, err := decodeTicker(parts, env)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1000 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	if funding == nil || funding.Rate != "0.0001" || funding.NextFundingTS != 1783822800000 {
		t.Errorf("funding = %+v", funding)
	}
	if oi == nil || oi.OpenInterest != "850000000" {
		t.Errorf("oi = %+v", oi)
	}
}

func TestDecodeTicker_DeltaOmitsUnchangedFields(t *testing.T) {
	// A delta update that only touches lastPrice (not modeled here) should
	// leave both funding and OI nil rather than zero-valued.
	_, parts, env, _, _ := classify([]byte(`{"topic":"tickers.BTCUSDT","ts":1,"data":{"symbol":"BTCUSDT"}}`))
	_, _, funding, oi, err := decodeTicker(parts, env)
	if err != nil {
		t.Fatal(err)
	}
	if funding != nil || oi != nil {
		t.Errorf("funding=%v oi=%v, want both nil for a delta with neither field present", funding, oi)
	}
}

func TestDecodeOrderbook(t *testing.T) {
	_, _, env, _, _ := classify([]byte(`{"topic":"orderbook.50.BTCUSDT","type":"snapshot","ts":1,"data":{
		"s":"BTCUSDT","b":[["99","1"]],"a":[["101","2"]],"u":100,"seq":5000
	}}`))
	m, err := decodeOrderbook(env)
	if err != nil {
		t.Fatal(err)
	}
	if m.U != 100 || len(m.Bids) != 1 || m.Bids[0][0] != "99" {
		t.Errorf("m = %+v", m)
	}
}

func TestSubscribeArgs(t *testing.T) {
	args := subscribeArgs([]string{"btcusdt"})
	want := 3 + len(timeframes) // publicTrade + tickers + orderbook + N klines
	if len(args) != want {
		t.Fatalf("len = %d, want %d", len(args), want)
	}
	has := func(s string) bool {
		for _, a := range args {
			if a == s {
				return true
			}
		}
		return false
	}
	for _, w := range []string{"publicTrade.BTCUSDT", "tickers.BTCUSDT", "orderbook.50.BTCUSDT", "kline.1.BTCUSDT", "kline.D.BTCUSDT"} {
		if !has(w) {
			t.Errorf("missing %q in %v", w, args)
		}
	}
}

func TestOrderbookTopic(t *testing.T) {
	if got := orderbookTopic("btcusdt"); got != "orderbook.50.BTCUSDT" {
		t.Errorf("got %q", got)
	}
}
