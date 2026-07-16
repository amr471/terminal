package bingx

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func gz(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return b.Bytes()
}

func TestDecompressRoundTrip(t *testing.T) {
	dec, err := decompress(gz(`{"dataType":"BTC-USDT@trade","data":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(dec) != `{"dataType":"BTC-USDT@trade","data":[]}` {
		t.Fatalf("decompressed = %s", dec)
	}
}

func TestParseDataType(t *testing.T) {
	cases := []struct{ in, sym, kind, iv string }{
		{"BTC-USDT@trade", "BTC-USDT", "trade", ""},
		{"BTC-USDT@kline_1min", "BTC-USDT", "kline", "1min"},
		{"ETH-USDT@kline_60min", "ETH-USDT", "kline", "60min"},
		{"BTC-USDT@depth20@200ms", "BTC-USDT", "depth", ""},
	}
	for _, c := range cases {
		s, k, iv, ok := parseDataType(c.in)
		if !ok || s != c.sym || k != c.kind || iv != c.iv {
			t.Fatalf("parseDataType(%q) = %q,%q,%q,%v", c.in, s, k, iv, ok)
		}
	}
	if _, _, _, ok := parseDataType("BTC-USDT@bookTicker"); ok {
		t.Fatal("bookTicker should be unconsumed (ok=false)")
	}
}

func TestClassifyIgnoresAck(t *testing.T) {
	if _, _, _, _, ok, err := classify([]byte(`{"id":"1","code":0,"msg":""}`)); err != nil || ok {
		t.Fatalf("ack classify ok=%v err=%v", ok, err)
	}
}

func TestDecodeTradesArrayAndSide(t *testing.T) {
	data := json.RawMessage(`[{"T":1700000000000,"s":"BTC-USDT","m":true,"p":"64000.5","q":"0.1"},
	                          {"T":1700000000001,"s":"BTC-USDT","m":false,"p":"64001","q":"0.2"}]`)
	out, err := decodeTrades("BTC-USDT", data)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d", len(out))
	}
	if out[0].Symbol != "btcusdt" || out[0].Trade.Side != "sell" || out[0].Trade.Price != "64000.5" || out[0].TS != 1700000000000 {
		t.Fatalf("trade[0] = %+v", out[0])
	}
	if out[1].Trade.Side != "buy" {
		t.Fatalf("trade[1] side = %q, want buy", out[1].Trade.Side)
	}
}

func TestDecodeTradesSingleObject(t *testing.T) {
	out, err := decodeTrades("BTC-USDT", json.RawMessage(`{"T":1,"s":"BTC-USDT","m":false,"p":"1","q":"1"}`))
	if err != nil || len(out) != 1 || out[0].Trade.Side != "buy" {
		t.Fatalf("single trade = %+v err=%v", out, err)
	}
}

func TestDecodeKline(t *testing.T) {
	data := json.RawMessage(`{"e":"kline","E":1700000000000,"s":"BTC-USDT","K":{"t":1700000000000,"T":1700000059999,"o":"1","c":"2","h":"3","l":"0.5","v":"10","q":"20"}}`)
	c, err := decodeKline("BTC-USDT", "60min", data)
	if err != nil {
		t.Fatal(err)
	}
	if c.Symbol != "btcusdt" || c.Candle.TF != "1h" || c.Candle.Open != "1" || c.Candle.Close != "2" || c.Candle.High != "3" || c.Candle.Low != "0.5" || c.Candle.Volume != "10" {
		t.Fatalf("kline = %+v", c.Candle)
	}
	if c.TS != 1700000000000 {
		t.Fatalf("ts = %d", c.TS)
	}
	if _, err := decodeKline("BTC-USDT", "7min", data); err == nil {
		t.Fatal("expected error on unknown interval")
	}
}

func TestDecodeDepthSnapshot(t *testing.T) {
	data := json.RawMessage(`{"bids":[["63999","1.2"],["63998","0.5"]],"asks":[["64001","0.8"]],"ts":1700000000000}`)
	b, err := decodeDepth("BTC-USDT", data)
	if err != nil {
		t.Fatal(err)
	}
	if b.Symbol != "btcusdt" || !b.Book.Snapshot || b.TS != 1700000000000 {
		t.Fatalf("book = %+v", b)
	}
	if len(b.Book.Bids) != 2 || b.Book.Bids[0] != [2]norm.Dec{"63999", "1.2"} {
		t.Fatalf("bids = %v", b.Book.Bids)
	}
	if len(b.Book.Asks) != 1 || b.Book.Asks[0] != [2]norm.Dec{"64001", "0.8"} {
		t.Fatalf("asks = %v", b.Book.Asks)
	}
}

func TestCandleTrackerRollover(t *testing.T) {
	tr := newCandleTracker()
	mk := func(ts int64, c string) candleOut {
		return candleOut{Symbol: "btcusdt", TS: ts, Candle: norm.Candle{TF: "1h", Close: c}}
	}
	if _, has, _ := tr.observe(mk(1000, "1")); has {
		t.Fatal("first observe should not finalize")
	}
	fin, has, live := tr.observe(mk(2000, "2"))
	if !has || !fin.Candle.Final || fin.TS != 1000 || fin.Candle.Close != "1" {
		t.Fatalf("finalized = %+v has=%v", fin, has)
	}
	if live.TS != 2000 || live.Candle.Final {
		t.Fatalf("live = %+v", live)
	}
}
