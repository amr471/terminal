package mexc

import (
	"encoding/json"
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func TestClassifyIgnoresAckAndPong(t *testing.T) {
	for _, raw := range []string{
		`{"channel":"rs.sub.deal","data":"success","ts":1}`,
		`{"channel":"pong","data":1587453241453}`,
		`{"channel":"rs.error","data":"bad"}`,
	} {
		if _, _, _, _, ok, err := classify([]byte(raw)); err != nil || ok {
			t.Fatalf("classify(%s) ok=%v err=%v; want ok=false", raw, ok, err)
		}
	}
}

func TestDecodeDeals(t *testing.T) {
	raw := `{"channel":"push.deal","symbol":"BTC_USDT","ts":1755487578276,"data":[
	  {"p":115309.8,"v":55,"T":1,"O":3,"M":1,"t":1755487578276,"i":13064218826},
	  {"p":115309.8,"v":11,"T":2,"O":3,"M":1,"t":1755487578275,"i":13064218827}]}`
	ch, sym, data, _, ok, err := classify([]byte(raw))
	if err != nil || !ok || ch != "push.deal" || sym != "BTC_USDT" {
		t.Fatalf("classify = %q %q ok=%v err=%v", ch, sym, ok, err)
	}
	trades, err := decodeDeals(sym, data)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 2 {
		t.Fatalf("got %d trades", len(trades))
	}
	if trades[0].Symbol != "btcusdt" || trades[0].Trade.Side != "buy" || trades[0].Trade.Price != "115309.8" || trades[0].Trade.Qty != "55" || trades[0].Trade.ID != "13064218826" {
		t.Fatalf("trade[0] = %+v", trades[0])
	}
	if trades[1].Trade.Side != "sell" || trades[1].TS != 1755487578275 {
		t.Fatalf("trade[1] = %+v", trades[1])
	}
}

func TestDecodeKlineSecondsToMs(t *testing.T) {
	raw := `{"symbol":"BTC_USDT","interval":"Min60","a":233.74,"c":6885,"h":6910.5,"l":6885,"o":6894.5,"q":1611754,"t":1587448800}`
	c, err := decodeKline("BTC_USDT", json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if c.Symbol != "btcusdt" || c.Candle.TF != "1h" {
		t.Fatalf("symbol/tf = %q/%q", c.Symbol, c.Candle.TF)
	}
	if c.Candle.Open != "6894.5" || c.Candle.Close != "6885" || c.Candle.High != "6910.5" || c.Candle.Low != "6885" || c.Candle.Volume != "1611754" {
		t.Fatalf("OHLCV = %+v", c.Candle)
	}
	if c.TS != 1587448800000 { // seconds -> ms
		t.Fatalf("ts = %d, want 1587448800000", c.TS)
	}
}

func TestDecodeKlineUnknownInterval(t *testing.T) {
	if _, err := decodeKline("BTC_USDT", json.RawMessage(`{"symbol":"BTC_USDT","interval":"Min7"}`)); err == nil {
		t.Fatal("expected error on unknown interval")
	}
}

func TestDecodeFundingEitherFieldName(t *testing.T) {
	// sample uses "rate"
	sym, f, err := decodeFunding("BTC_USDT", json.RawMessage(`{"rate":0.001,"symbol":"BTC_USDT"}`))
	if err != nil || sym != "btcusdt" || f.Rate != "0.001" {
		t.Fatalf("rate form: %q %+v err=%v", sym, f, err)
	}
	// field table uses "fundingRate" + nextSettleTime
	_, f2, err := decodeFunding("ETH_USDT", json.RawMessage(`{"fundingRate":-0.0002,"nextSettleTime":1700000000000}`))
	if err != nil || f2.Rate != "-0.0002" || f2.NextFundingTS != 1700000000000 {
		t.Fatalf("fundingRate form: %+v err=%v", f2, err)
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
