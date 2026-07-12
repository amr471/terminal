package conn

import (
	"testing"
	"time"
)

func TestBackoff_ExponentialCeilingWithFullJitter(t *testing.T) {
	// rand pinned to the ceiling (just under 1.0) exposes the exponential curve.
	b := NewBackoff()
	b.rand = func() float64 { return 0.999999 }

	prev := time.Duration(0)
	for i := 0; i < 6; i++ {
		d := b.Next()
		ceil := time.Second << i // 1s·2^i
		if d > ceil {
			t.Fatalf("attempt %d: delay %v exceeds ceiling %v", i, d, ceil)
		}
		if d < prev {
			t.Fatalf("attempt %d: ceiling should grow (got %v after %v)", i, d, prev)
		}
		prev = d
	}
}

func TestBackoff_CapsAt60s(t *testing.T) {
	b := NewBackoff()
	b.rand = func() float64 { return 0.999999 }
	for i := 0; i < 40; i++ { // way past 2^6 = 64s > cap
		if d := b.Next(); d > 60*time.Second {
			t.Fatalf("attempt %d: delay %v exceeds 60s cap (§5.1)", i, d)
		}
	}
}

func TestBackoff_FullJitterLowerBoundIsZero(t *testing.T) {
	b := NewBackoff()
	b.rand = func() float64 { return 0 }
	if d := b.Next(); d != 0 {
		t.Fatalf("full jitter allows 0 delay, got %v", d)
	}
}

func TestBackoff_ResetRestartsCurve(t *testing.T) {
	b := NewBackoff()
	b.rand = func() float64 { return 0.999999 }
	for i := 0; i < 5; i++ {
		b.Next()
	}
	b.Reset()
	if got := b.Next(); got > time.Second {
		t.Fatalf("after Reset, first delay must be within base ceiling 1s, got %v", got)
	}
}
