package store

import (
	"testing"

	"github.com/shopspring/decimal"
)

func dec(s string) decimal.Decimal {
	d, err := decimal.NewFromString(s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestPercentChange(t *testing.T) {
	got := percentChange(dec("110"), dec("100"))
	if got == nil || !got.Equal(dec("0.1")) {
		t.Errorf("got %v, want 0.1", got)
	}

	got = percentChange(dec("95"), dec("100"))
	if got == nil || !got.Equal(dec("-0.05")) {
		t.Errorf("got %v, want -0.05", got)
	}
}

func TestPercentChange_ZeroPrior(t *testing.T) {
	if got := percentChange(dec("100"), dec("0")); got != nil {
		t.Errorf("got %v, want nil (can't divide by zero baseline)", got)
	}
}

func TestVolatility24h_NotEnoughHistory(t *testing.T) {
	if got := volatility24h(nil); got != nil {
		t.Errorf("got %v, want nil for 0 closes", got)
	}
	if got := volatility24h([]decimal.Decimal{dec("100")}); got != nil {
		t.Errorf("got %v, want nil for 1 close", got)
	}
}

func TestVolatility24h_ConstantPriceIsZero(t *testing.T) {
	closes := []decimal.Decimal{dec("100"), dec("100"), dec("100"), dec("100")}
	got := volatility24h(closes)
	if got == nil {
		t.Fatal("got nil, want zero")
	}
	if !got.Round(8).IsZero() {
		t.Errorf("got %v, want ~0 (no price movement)", got)
	}
}

func TestVolatility24h_PositiveForMovingPrice(t *testing.T) {
	closes := []decimal.Decimal{dec("100"), dec("110"), dec("95"), dec("120"), dec("90")}
	got := volatility24h(closes)
	if got == nil || !got.IsPositive() {
		t.Errorf("got %v, want a positive volatility", got)
	}
}

func TestSpreadFraction(t *testing.T) {
	bid, ask := dec("99"), dec("101")
	got := spreadFraction(&bid, &ask)
	// (101-99)/((101+99)/2) = 2/100 = 0.02
	if got == nil || !got.Equal(dec("0.02")) {
		t.Errorf("got %v, want 0.02", got)
	}
}

func TestSpreadFraction_MissingSide(t *testing.T) {
	ask := dec("101")
	if got := spreadFraction(nil, &ask); got != nil {
		t.Errorf("got %v, want nil (no bid)", got)
	}
	bid := dec("99")
	if got := spreadFraction(&bid, nil); got != nil {
		t.Errorf("got %v, want nil (no ask)", got)
	}
}
