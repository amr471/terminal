package okx

import (
	"encoding/json"
	"fmt"
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
	// Real bug found 2026-07-18: event acks DO carry "arg" on OKX (they
	// echo back the channel/instId just subscribed), so a naive `Arg == nil`
	// check alone does NOT filter them out — they used to reach handle()
	// and fail to decode ("unexpected end of JSON input" on the missing
	// "data" field). classify() now checks Event != "" first; assert that
	// actually holds, not just document the shape.
	_, _, _, _, ok, err := classify([]byte(`{"event":"subscribe","arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"connId":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("subscribe ack (event+arg both present) should be ok=false, not routed as a data push")
	}
}

func TestClassify_ErrorEventWithoutArgIgnored(t *testing.T) {
	_, _, _, _, ok, err := classify([]byte(`{"event":"error","code":"60012","msg":"Invalid request"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("error frame should be ok=false")
	}
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

func TestSubscribeBatches_EachBatchWithinByteLimit(t *testing.T) {
	// 200 symbols x 10 streams/symbol ~= 2000 args — the exact shape that
	// produced `websocket: close 1009 (message too big)` in production
	// 2026-07-17 when sent as one SUBSCRIBE message.
	symbols := make([]string, 200)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("sym%dusdt", i)
	}
	args := subscribeArgsFor(symbols)
	batches := subscribeBatches(args)
	if len(batches) < 2 {
		t.Fatalf("expected multiple batches for %d args, got %d batch(es)", len(args), len(batches))
	}
	var total int
	for i, batch := range batches {
		if len(batch) == 0 {
			t.Fatalf("batch %d is empty", i)
		}
		encoded, err := json.Marshal(map[string]any{"op": "subscribe", "args": batch})
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) > 4096 {
			t.Fatalf("batch %d encodes to %d bytes, exceeds OKX's 4096-byte limit", i, len(encoded))
		}
		total += len(batch)
	}
	if total != len(args) {
		t.Fatalf("batches carry %d args total, want %d (none dropped/duplicated)", total, len(args))
	}
}

func TestSubscribeBatches_SmallInputIsOneBatch(t *testing.T) {
	args := subscribeArgsFor([]string{"btcusdt"})
	batches := subscribeBatches(args)
	if len(batches) != 1 || len(batches[0]) != len(args) {
		t.Fatalf("batches = %+v, want a single batch of %d args", batches, len(args))
	}
}

func TestSubscribeBatches_EmptyInput(t *testing.T) {
	if batches := subscribeBatches(nil); batches != nil {
		t.Fatalf("batches = %+v, want nil for empty input", batches)
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
