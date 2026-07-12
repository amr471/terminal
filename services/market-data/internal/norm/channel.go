package norm

import (
	"fmt"
	"strings"
)

// Channel kinds on md.* (architecture.md §4.1).
const (
	KindTrades  = "trades"
	KindBook    = "book"
	KindCandles = "candles"
	KindFunding = "funding"
	KindOI      = "oi"
)

var validTFs = map[string]bool{
	"1m": true, "5m": true, "15m": true, "1h": true, "4h": true, "1d": true,
}

// Channel identifies one md.* pub/sub channel.
type Channel struct {
	Exchange string
	Symbol   string // normalized lowercase, e.g. "btcusdt"
	Kind     string
	TF       string // set iff Kind == KindCandles
}

// String renders "md.{exchange}.{symbol}.{kind}[.{tf}]" — must stay identical
// to mdChannel() in @terminal/types.
func (c Channel) String() string {
	if c.Kind == KindCandles {
		tf := c.TF
		if tf == "" {
			tf = "1m"
		}
		return fmt.Sprintf("md.%s.%s.%s.%s", c.Exchange, c.Symbol, c.Kind, tf)
	}
	return fmt.Sprintf("md.%s.%s.%s", c.Exchange, c.Symbol, c.Kind)
}

// ParseChannel is the inverse of String; the error names what was malformed.
func ParseChannel(name string) (Channel, error) {
	parts := strings.Split(name, ".")
	if len(parts) < 4 || parts[0] != "md" {
		return Channel{}, fmt.Errorf("norm: not an md channel: %q", name)
	}
	c := Channel{Exchange: parts[1], Symbol: parts[2], Kind: parts[3]}
	switch {
	case len(parts) == 4:
		switch c.Kind {
		case KindTrades, KindBook, KindFunding, KindOI:
			return c, nil
		}
		return Channel{}, fmt.Errorf("norm: unknown channel kind %q in %q", c.Kind, name)
	case len(parts) == 5 && c.Kind == KindCandles:
		if !validTFs[parts[4]] {
			return Channel{}, fmt.Errorf("norm: invalid timeframe %q in %q", parts[4], name)
		}
		c.TF = parts[4]
		return c, nil
	}
	return Channel{}, fmt.Errorf("norm: malformed channel %q", name)
}

// NormalizeSymbol lowercases and strips separators: "BTC-USDT" → "btcusdt".
func NormalizeSymbol(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, "_", "")
	s = strings.ReplaceAll(s, "/", "")
	return s
}
