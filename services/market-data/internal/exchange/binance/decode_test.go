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

func TestSubscribeParamsIncludesDepth(t *testing.T) {
	p := subscribeParams([]string{"btcusdt"})
	// aggTrade + markPrice + depth20 + 6 klines = 9.
	if len(p) != 9 {
		t.Fatalf("params = %d, want 9: %v", len(p), p)
	}
	var sawDepth bool
	for _, s := range p {
		if s == "btcusdt@depth20@100ms" {
			sawDepth = true
		}
	}
	if !sawDepth {
		t.Fatalf("missing depth stream in %v", p)
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

func TestSubscribeParams_CoversAllChannelsPerSymbol(t *testing.T) {
	params := subscribeParams([]string{"btcusdt", "ethusdt"})
	want := len(timeframes) + 3 // aggTrade + markPrice + depth + N klines, per symbol
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
}
