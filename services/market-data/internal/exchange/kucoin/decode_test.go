package kucoin

import (
	"encoding/json"
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func TestClassifyIgnoresControlFrames(t *testing.T) {
	for _, raw := range []string{
		`{"id":"1","type":"welcome"}`,
		`{"id":"1","type":"ack"}`,
		`{"id":"1","type":"pong"}`,
	} {
		if _, _, _, _, ok, err := classify([]byte(raw)); err != nil || ok {
			t.Fatalf("classify(%s) ok=%v err=%v; want ok=false", raw, ok, err)
		}
	}
}

func TestClassifyMessage(t *testing.T) {
	raw := `{"type":"message","topic":"/contractMarket/execution:XBTUSDTM","subject":"match","data":{}}`
	path, suffix, subject, _, ok, err := classify([]byte(raw))
	if err != nil || !ok {
		t.Fatalf("classify ok=%v err=%v", ok, err)
	}
	if path != "/contractMarket/execution" || suffix != "XBTUSDTM" || subject != "match" {
		t.Fatalf("path=%q suffix=%q subject=%q", path, suffix, subject)
	}
}

func TestDecodeTradeContractsAndXBT(t *testing.T) {
	raw := `{"symbol":"XBTUSDTM","side":"sell","size":50,"price":"64000.5","tradeId":"t1","ts":1700000000000000000}`
	tr, err := decodeTrade(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if tr.Symbol != "btcusdt" { // XBT -> BTC
		t.Fatalf("symbol = %q, want btcusdt", tr.Symbol)
	}
	if tr.Trade.Side != "sell" || tr.Trade.Price != "64000.5" || tr.Trade.Qty != "50" || tr.Trade.ID != "t1" {
		t.Fatalf("trade = %+v", tr.Trade)
	}
	if tr.TS != 1700000000000 { // ns -> ms
		t.Fatalf("ts = %d, want 1700000000000", tr.TS)
	}
}

func TestDecodeBookSnapshot(t *testing.T) {
	raw := `{"asks":[["64001","3"],["64002","1"]],"bids":[["63999","5"]],"ts":1700000000000000000}`
	b, err := decodeBook("XBTUSDTM", json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if b.Symbol != "btcusdt" || !b.Book.Snapshot {
		t.Fatalf("book = %+v", b)
	}
	if len(b.Book.Asks) != 2 || b.Book.Asks[0] != [2]norm.Dec{"64001", "3"} {
		t.Fatalf("asks = %v", b.Book.Asks)
	}
	if len(b.Book.Bids) != 1 || b.Book.Bids[0] != [2]norm.Dec{"63999", "5"} {
		t.Fatalf("bids = %v", b.Book.Bids)
	}
	if b.TS != 1700000000000 {
		t.Fatalf("ts = %d", b.TS)
	}
}

// KuCoin's array order is [time, open, CLOSE, high, low, volume, turnover] —
// distinct values catch an OHLC mis-mapping.
func TestDecodeCandleFieldOrder(t *testing.T) {
	raw := `{"symbol":"ETHUSDTM","candles":["1700000000000","3200","3210","3250","3190","1234","3950000"]}`
	c, err := decodeCandle("ETHUSDTM_1hour", json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if c.Symbol != "ethusdt" || c.Candle.TF != "1h" {
		t.Fatalf("symbol/tf = %q/%q", c.Symbol, c.Candle.TF)
	}
	if c.Candle.Open != "3200" || c.Candle.Close != "3210" || c.Candle.High != "3250" || c.Candle.Low != "3190" {
		t.Fatalf("OHLC = %+v", c.Candle)
	}
	if c.Candle.Volume != "1234" || c.Candle.QuoteVolume != "3950000" {
		t.Fatalf("vol = %+v", c.Candle)
	}
	if c.TS != 1700000000000 {
		t.Fatalf("ts = %d", c.TS)
	}
}

func TestDecodeCandleRejectsBadTopic(t *testing.T) {
	if _, err := decodeCandle("XBTUSDTM", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error: candle topic without granularity")
	}
	if _, err := decodeCandle("XBTUSDTM_7min", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error: unknown granularity")
	}
}

func TestDecodeFunding(t *testing.T) {
	raw := `{"granularity":60000,"fundingRate":-0.000123,"timestamp":1700000000000}`
	sym, ts, f, err := decodeFunding("XBTUSDTM", json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || ts != 1700000000000 || f.Rate != "-0.000123" {
		t.Fatalf("funding sym=%q ts=%d rate=%q", sym, ts, f.Rate)
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
