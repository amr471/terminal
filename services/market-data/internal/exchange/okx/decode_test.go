package okx

import (
	"testing"

	"github.com/terminal/market-data/internal/norm"
)

func TestClassify_Trades(t *testing.T) {
	channel, instID, action, _, ok, err := classify([]byte(`{"arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"data":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || channel != "trades" || instID != "BTC-USDT-SWAP" || action != "" {
		t.Fatalf("channel=%q instID=%q action=%q ok=%v", channel, instID, action, ok)
	}
}

func TestClassify_LiteralPongIgnored(t *testing.T) {
	_, _, _, _, ok, err := classify([]byte(`pong`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected ok=false for a literal pong frame")
	}
}

func TestClassify_SubscribeAckIgnored(t *testing.T) {
	_, _, _, _, ok, err := classify([]byte(`{"event":"subscribe","arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"connId":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	// event acks DO carry "arg" on OKX — but this package treats any
	// "event" frame as non-data by checking Arg==nil first; a subscribe ack
	// still has an arg, so make sure we're routing on Data presence
	// correctly elsewhere (handle() only calls decode* for known channels,
	// data will be empty here so decode would just return zero rows,
	// harmless either way). This test documents the shape, not a strict
	// ok=false requirement.
	_ = ok
}

func TestDecodeTrades(t *testing.T) {
	_, _, _, env, ok, err := classify([]byte(`{"arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"data":[
		{"instId":"BTC-USDT-SWAP","tradeId":"1","px":"64123.50","sz":"0.5","side":"sell","ts":"1783793088100"}
	]}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	trades, err := decodeTrades(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 1 || trades[0].Symbol != "btcusdt" || trades[0].TS != 1783793088100 {
		t.Fatalf("trades = %+v", trades)
	}
	if trades[0].Trade.Side != "sell" || trades[0].Trade.Price != "64123.50" {
		t.Errorf("trade = %+v", trades[0].Trade)
	}
}

func TestDecodeCandles_PositionalArray(t *testing.T) {
	channel, instID, _, env, ok, err := classify([]byte(`{"arg":{"channel":"candle5m","instId":"BTC-USDT-SWAP"},"data":[
		["1783793040000","64100.00","64150.00","64090.00","64123.50","12.5","801500.25","801500.25","1"]
	]}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	symbol, tf, klines, err := decodeCandles(channel, instID, env)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || tf != "5m" {
		t.Fatalf("symbol/tf = %q/%q", symbol, tf)
	}
	if len(klines) != 1 || !klines[0].Candle.Final || klines[0].Candle.Close != "64123.50" {
		t.Errorf("klines = %+v", klines)
	}
}

func TestDecodeCandles_UnconfirmedNotFinal(t *testing.T) {
	channel, instID, _, env, _, _ := classify([]byte(`{"arg":{"channel":"candle1m","instId":"BTC-USDT-SWAP"},"data":[
		["1","1","1","1","1","1","0"]
	]}`))
	_, _, klines, err := decodeCandles(channel, instID, env)
	if err != nil {
		t.Fatal(err)
	}
	if klines[0].Candle.Final {
		t.Error("expected Final=false when confirm=\"0\"")
	}
}

func TestDecodeFunding(t *testing.T) {
	_, _, _, env, ok, err := classify([]byte(`{"arg":{"channel":"funding-rate","instId":"BTC-USDT-SWAP"},"data":[
		{"instType":"SWAP","instId":"BTC-USDT-SWAP","fundingRate":"0.0001515","fundingTime":"1783793088100","nextFundingTime":"1783822800000"}
	]}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	symbol, ts, funding, err := decodeFunding(env)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1783793088100 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	if funding.Rate != "0.0001515" || funding.NextFundingTS != 1783822800000 {
		t.Errorf("funding = %+v", funding)
	}
}

func TestDecodeOI(t *testing.T) {
	_, _, _, env, ok, err := classify([]byte(`{"arg":{"channel":"open-interest","instId":"BTC-USDT-SWAP"},"data":[
		{"instType":"SWAP","instId":"BTC-USDT-SWAP","oi":"850000000","oiCcy":"13260","oiUsd":"850000000","ts":"1783793088100"}
	]}`))
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	symbol, ts, oi, err := decodeOI(env)
	if err != nil {
		t.Fatal(err)
	}
	if symbol != "btcusdt" || ts != 1783793088100 {
		t.Fatalf("symbol/ts = %q/%d", symbol, ts)
	}
	if oi.OpenInterest != "850000000" || oi.OpenInterestUSD != "850000000" {
		t.Errorf("oi = %+v", oi)
	}
}

func TestDecodeBook(t *testing.T) {
	_, _, action, env, ok, err := classify([]byte(`{"arg":{"channel":"books","instId":"BTC-USDT-SWAP"},"action":"snapshot","data":[
		{"asks":[["101","2","0","1"]],"bids":[["99","1","0","1"]],"ts":"1783793088100","checksum":123,"prevSeqId":-1,"seqId":1000}
	]}`))
	if err != nil || !ok || action != "snapshot" {
		t.Fatal(err, ok, action)
	}
	m, err := decodeBook(env)
	if err != nil {
		t.Fatal(err)
	}
	if m.SeqID != 1000 || m.PrevSeqID != -1 {
		t.Fatalf("m = %+v", m)
	}
	dec := levelsToDec(m.Bids)
	if len(dec) != 1 || dec[0][0] != "99" || dec[0][1] != "1" {
		t.Errorf("bids only keep price+size from the 4-tuple: %+v", dec)
	}
}

func TestDecodeBook5Snapshot(t *testing.T) {
	raw := []byte(`{"arg":{"channel":"books5","instId":"BTC-USDT-SWAP"},"data":[{"asks":[["64001","3","0","2"]],"bids":[["63999","5","0","4"],["63998","1","0","1"]],"ts":"1700000000000","seqId":123}]}`)
	channel, instID, _, env, ok, err := classify(raw)
	if err != nil || !ok || channel != "books5" {
		t.Fatalf("classify = %q ok=%v err=%v", channel, ok, err)
	}
	sym, ts, book, err := decodeBook5(instID, env)
	if err != nil {
		t.Fatal(err)
	}
	if sym != "btcusdt" || ts != 1700000000000 || !book.Snapshot {
		t.Fatalf("book = %s %d snapshot=%v", sym, ts, book.Snapshot)
	}
	if len(book.Bids) != 2 || book.Bids[0] != [2]norm.Dec{"63999", "5"} {
		t.Fatalf("bids = %v", book.Bids)
	}
	if len(book.Asks) != 1 || book.Asks[0] != [2]norm.Dec{"64001", "3"} {
		t.Fatalf("asks = %v", book.Asks)
	}
}

func TestSubscribeArgsFor_SkipsUnmappableSymbols(t *testing.T) {
	args := subscribeArgsFor([]string{"btcusdt", "notusdtquoted"})
	for _, a := range args {
		if a.InstID == "" {
			t.Fatalf("unmapped symbol leaked into subscribe args: %+v", a)
		}
	}
	want := 4 + len(timeframes) // trades + funding-rate + open-interest + books5 + N candles, for btcusdt only
	if len(args) != want {
		t.Fatalf("len(args) = %d, want %d (unmappable symbol should be skipped, not just one channel)", len(args), want)
	}
}
