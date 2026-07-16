package hyperliquid

import (
	"encoding/json"
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func TestClassifyIgnoresNonData(t *testing.T) {
	for _, raw := range []string{
		`{"channel":"subscriptionResponse","data":{}}`,
		`{"channel":"pong"}`,
		`{"channel":"error","data":"bad"}`,
	} {
		if _, _, ok, err := classify([]byte(raw)); err != nil || ok {
			t.Fatalf("classify(%s) = ok %v err %v; want ok=false", raw, ok, err)
		}
	}
}

func TestDecodeTrades(t *testing.T) {
	raw := `[{"coin":"BTC","side":"B","px":"64000.5","sz":"0.10","time":1700000000000,"tid":42,"hash":"0x"},
	         {"coin":"ETH","side":"A","px":"3200","sz":"1.5","time":1700000000001,"tid":43,"hash":"0x"}]`
	_, data, ok, err := classify([]byte(`{"channel":"trades","data":` + raw + `}`))
	if err != nil || !ok {
		t.Fatalf("classify trades = ok %v err %v", ok, err)
	}
	out, err := decodeTrades(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d trades, want 2", len(out))
	}
	if out[0].Symbol != "btcusdt" || out[0].Trade.Side != "buy" || out[0].Trade.Price != "64000.5" || out[0].Trade.ID != "42" {
		t.Fatalf("trade[0] = %+v", out[0])
	}
	if out[1].Symbol != "ethusdt" || out[1].Trade.Side != "sell" {
		t.Fatalf("trade[1] = %+v", out[1])
	}
}

func TestDecodeBookSnapshot(t *testing.T) {
	raw := `{"coin":"BTC","time":1700000000000,"levels":[
	   [{"px":"63999","sz":"1.2","n":3},{"px":"63998","sz":"0.5","n":1}],
	   [{"px":"64001","sz":"0.8","n":2}]]}`
	b, err := decodeBook(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if b.Symbol != "btcusdt" || !b.Book.Snapshot {
		t.Fatalf("book = %+v (want btcusdt snapshot)", b)
	}
	if len(b.Book.Bids) != 2 || b.Book.Bids[0] != [2]norm.Dec{"63999", "1.2"} {
		t.Fatalf("bids = %v", b.Book.Bids)
	}
	if len(b.Book.Asks) != 1 || b.Book.Asks[0] != [2]norm.Dec{"64001", "0.8"} {
		t.Fatalf("asks = %v", b.Book.Asks)
	}
}

func TestDecodeBookRejectsMalformedLevels(t *testing.T) {
	if _, err := decodeBook(json.RawMessage(`{"coin":"BTC","levels":[[]]}`)); err == nil {
		t.Fatal("expected error on levels != 2")
	}
}

// decodeCandle must accept o/c/h/l/v as JSON numbers OR strings (flexStr).
func TestDecodeCandleFlexNumbers(t *testing.T) {
	numeric := `{"t":1700000000000,"T":1700000059999,"s":"SOL","i":"5m","o":150.5,"c":151,"h":152,"l":150,"v":1234.5,"n":88}`
	c, err := decodeCandle(json.RawMessage(numeric))
	if err != nil {
		t.Fatal(err)
	}
	if c.Symbol != "solusdt" || c.Candle.TF != "5m" || c.Candle.Open != "150.5" || c.Candle.Close != "151" || c.Candle.Volume != "1234.5" || c.Candle.TradeCount != 88 {
		t.Fatalf("numeric candle = %+v", c.Candle)
	}
	strv := `{"t":1700000000000,"T":1700000059999,"s":"SOL","i":"5m","o":"150.5","c":"151","h":"152","l":"150","v":"1234.5","n":88}`
	c2, err := decodeCandle(json.RawMessage(strv))
	if err != nil {
		t.Fatal(err)
	}
	if c2.Candle.Open != "150.5" || c2.Candle.Close != "151" {
		t.Fatalf("string candle = %+v", c2.Candle)
	}
}

func TestDecodeAssetCtx(t *testing.T) {
	raw := `{"coin":"BTC","ctx":{"funding":0.0000125,"openInterest":"1234.5","markPx":64000,"oraclePx":63999,"dayNtlVlm":1000000}}`
	c, err := decodeAssetCtx(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	if c.Symbol != "btcusdt" || c.Funding == nil || c.Funding.Rate != "0.0000125" {
		t.Fatalf("ctx funding = %+v", c.Funding)
	}
	if c.OI == nil || c.OI.OpenInterest != "1234.5" {
		t.Fatalf("ctx oi = %+v", c.OI)
	}
}

func TestCandleTrackerRollover(t *testing.T) {
	tr := newCandleTracker()
	mk := func(ts int64, close string) candleOut {
		return candleOut{Symbol: "btcusdt", TS: ts, Candle: norm.Candle{TF: "1m", Close: close}}
	}
	// First observation: live only, no finalized bucket yet.
	fin, has, live := tr.observe(mk(1000, "100"))
	if has || live.Candle.Final {
		t.Fatalf("first observe: has=%v liveFinal=%v", has, live.Candle.Final)
	}
	// Same bucket updated: still no finalize.
	if _, has, _ := tr.observe(mk(1000, "101")); has {
		t.Fatal("same-bucket update should not finalize")
	}
	// New bucket: prior bucket finalizes with its last-seen close (101).
	fin, has, live = tr.observe(mk(2000, "200"))
	if !has || !fin.Candle.Final || fin.TS != 1000 || fin.Candle.Close != "101" {
		t.Fatalf("rollover finalized = %+v has=%v", fin.Candle, has)
	}
	if live.TS != 2000 || live.Candle.Final {
		t.Fatalf("live after rollover = %+v", live.Candle)
	}
}
