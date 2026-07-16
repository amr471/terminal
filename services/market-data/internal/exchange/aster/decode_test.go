package aster

import "testing"

func TestClassifyRejectsAckFrames(t *testing.T) {
	if _, err := classify([]byte(`{"result":null,"id":1}`)); err == nil {
		t.Fatal("expected error: subscribe ack has no \"e\"")
	}
}

func TestDecodeAggTradeMakerIsSell(t *testing.T) {
	raw := []byte(`{"e":"aggTrade","E":1700000000000,"s":"BTCUSDT","p":"64000.5","q":"0.10","m":true,"a":42}`)
	sym, ts, tr, err := decodeAggTrade(raw)
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || ts != 1700000000000 || tr.Side != "sell" || tr.Price != "64000.5" || tr.ID != "42" {
		t.Fatalf("aggTrade = %s %d %+v", sym, ts, tr)
	}
	// buyer not maker => taker bought.
	_, _, tr2, _ := decodeAggTrade([]byte(`{"e":"aggTrade","s":"ETHUSDT","p":"1","q":"1","m":false,"a":1}`))
	if tr2.Side != "buy" {
		t.Fatalf("m=false side = %q, want buy", tr2.Side)
	}
}

func TestDecodeKlineFinal(t *testing.T) {
	raw := []byte(`{"e":"kline","E":1700000000000,"s":"BTCUSDT","k":{"i":"1h","o":"1","h":"3","l":"0.5","c":"2","v":"10","q":"20","n":5,"x":true}}`)
	sym, _, c, err := decodeKline(raw)
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || c.TF != "1h" || c.Open != "1" || c.High != "3" || c.Low != "0.5" || c.Close != "2" || !c.Final {
		t.Fatalf("kline = %+v", c)
	}
}

func TestDecodeMarkPriceFunding(t *testing.T) {
	raw := []byte(`{"e":"markPriceUpdate","E":1700000000000,"s":"BTCUSDT","p":"64000","r":"0.00038167","T":1700000400000}`)
	sym, ts, f, err := decodeMarkPrice(raw)
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || ts != 1700000000000 || f.Rate != "0.00038167" || f.NextFundingTS != 1700000400000 {
		t.Fatalf("markPrice = %s %d %+v", sym, ts, f)
	}
}

func TestDecodePartialDepthSnapshot(t *testing.T) {
	raw := []byte(`{"e":"depthUpdate","E":1700000000000,"s":"BTCUSDT","U":1,"u":5,"pu":0,"b":[["63999","1.2"],["63998","0.5"]],"a":[["64001","0.8"]]}`)
	sym, ts, book, err := decodePartialDepth(raw)
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || ts != 1700000000000 || !book.Snapshot {
		t.Fatalf("depth = %s %d snapshot=%v", sym, ts, book.Snapshot)
	}
	if len(book.Bids) != 2 || book.Bids[0][0] != "63999" || book.Bids[0][1] != "1.2" {
		t.Fatalf("bids = %v", book.Bids)
	}
	if len(book.Asks) != 1 || book.Asks[0][0] != "64001" {
		t.Fatalf("asks = %v", book.Asks)
	}
}

func TestSubscribeParams(t *testing.T) {
	p := subscribeParams([]string{"btcusdt", "ethusdt"})
	// per symbol: aggTrade + markPrice + depth20 + 6 klines = 9; two symbols = 18.
	if len(p) != 18 {
		t.Fatalf("params = %d, want 18: %v", len(p), p)
	}
	var sawDepth, sawKline bool
	for _, s := range p {
		if s == "btcusdt@depth20@100ms" {
			sawDepth = true
		}
		if s == "ethusdt@kline_4h" {
			sawKline = true
		}
	}
	if !sawDepth || !sawKline {
		t.Fatalf("missing params: depth=%v kline=%v", sawDepth, sawKline)
	}
}
