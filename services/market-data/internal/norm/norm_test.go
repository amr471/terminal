package norm

import (
	"encoding/json"
	"testing"
)

// Golden channel names — MUST match @terminal/types mdChannel()/parseMdChannel()
// (packages/types/src/contracts.test.ts uses the same values).
func TestChannelString_GoldensMatchTS(t *testing.T) {
	tests := []struct {
		name string
		in   Channel
		want string
	}{
		{"trades", Channel{Exchange: "binance", Symbol: "btcusdt", Kind: KindTrades}, "md.binance.btcusdt.trades"},
		{"book", Channel{Exchange: "bybit", Symbol: "solusdt", Kind: KindBook}, "md.bybit.solusdt.book"},
		{"candles", Channel{Exchange: "okx", Symbol: "ethusdt", Kind: KindCandles, TF: "5m"}, "md.okx.ethusdt.candles.5m"},
		{"candles default tf", Channel{Exchange: "binance", Symbol: "btcusdt", Kind: KindCandles}, "md.binance.btcusdt.candles.1m"},
		{"funding", Channel{Exchange: "binance", Symbol: "btcusdt", Kind: KindFunding}, "md.binance.btcusdt.funding"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.in.String(); got != tt.want {
				t.Errorf("String() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseChannel_RoundTrip(t *testing.T) {
	for _, name := range []string{
		"md.binance.btcusdt.trades",
		"md.okx.ethusdt.candles.1h",
		"md.bybit.solusdt.oi",
	} {
		c, err := ParseChannel(name)
		if err != nil {
			t.Fatalf("ParseChannel(%q): %v", name, err)
		}
		if got := c.String(); got != name {
			t.Errorf("round trip: got %q, want %q", got, name)
		}
	}
}

func TestParseChannel_RejectsMalformed(t *testing.T) {
	for _, name := range []string{
		"evt.alert_fired",
		"md.binance.btcusdt.nonsense",
		"md.binance.btcusdt.candles.7m",
		"md.binance",
		"",
	} {
		if _, err := ParseChannel(name); err == nil {
			t.Errorf("ParseChannel(%q): want error, got nil", name)
		}
	}
}

func TestNormalizeSymbol(t *testing.T) {
	tests := map[string]string{
		"BTC-USDT": "btcusdt",
		"BTC_USDT": "btcusdt",
		"ETH/USD":  "ethusd",
		"solusdt":  "solusdt",
	}
	for in, want := range tests {
		if got := NormalizeSymbol(in); got != want {
			t.Errorf("NormalizeSymbol(%q) = %q, want %q", in, got, want)
		}
	}
}

// The JSON wire shape must byte-match what @terminal/types expects (§4.2):
// keys v/type/src/sym/ts/rts/seq/data, prices as strings.
func TestEnvelope_WireShape(t *testing.T) {
	env := Envelope{
		V: 1, Type: TypeTrade, Src: "binance", Sym: "btcusdt",
		TS: 1783793088123, RTS: 1783793088140, Seq: 42,
		Data: Trade{Price: "64123.50", Qty: "0.5", Side: "buy"},
	}
	got, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"type":"trade","src":"binance","sym":"btcusdt",` +
		`"ts":1783793088123,"rts":1783793088140,"seq":42,` +
		`"data":{"price":"64123.50","qty":"0.5","side":"buy"}}`
	if string(got) != want {
		t.Errorf("wire shape mismatch:\n got  %s\n want %s", got, want)
	}

	// Round trip: price must survive as an exact string, never a float.
	var back Envelope
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatal(err)
	}
	data, ok := back.Data.(map[string]any)
	if !ok {
		t.Fatalf("data decoded to %T", back.Data)
	}
	if price, ok := data["price"].(string); !ok || price != "64123.50" {
		t.Errorf("price corrupted in round trip: %#v", data["price"])
	}
}
