package health

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorst_MatchesTSWorstState(t *testing.T) {
	tests := []struct {
		in   []State
		want State
	}{
		{[]State{StateLive, StateLive}, StateLive},
		{[]State{StateLive, StateDegraded, StateStale}, StateStale},
		{[]State{StateDown, StateLive}, StateDown},
		{nil, StateLive},
	}
	for _, tt := range tests {
		if got := Worst(tt.in); got != tt.want {
			t.Errorf("Worst(%v) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

func TestReport_WireShape(t *testing.T) {
	reg := NewRegistry()
	reg.Set("binance.ws", StateLive)
	reg.Set("coinglass.rest", StateDegraded)

	payload, err := json.Marshal(reg.Report(time.UnixMilli(1783793088000)))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	// §5.5 contract keys.
	if got["status"] != "DEGRADED" {
		t.Errorf("status = %v, want DEGRADED (worst-of)", got["status"])
	}
	feeds, ok := got["feeds"].(map[string]any)
	if !ok || feeds["binance.ws"] != "LIVE" || feeds["coinglass.rest"] != "DEGRADED" {
		t.Errorf("feeds wrong: %#v", got["feeds"])
	}
	if got["updatedAt"] != float64(1783793088000) {
		t.Errorf("updatedAt = %v", got["updatedAt"])
	}
}

func TestHandler_ReadyzGatesOnState(t *testing.T) {
	reg := NewRegistry()
	reg.Set("binance.ws", StateLive)
	h := Handler(reg)

	for _, tt := range []struct {
		state State
		path  string
		want  int
	}{
		{StateLive, "/readyz", 200},
		{StateDegraded, "/readyz", 200}, // degraded still serves (§5.6)
		{StateStale, "/readyz", 503},
		{StateDown, "/readyz", 503},
		{StateDown, "/healthz", 200}, // liveness: process is up
	} {
		reg.Set("binance.ws", tt.state)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", tt.path, nil))
		if rec.Code != tt.want {
			t.Errorf("%s with %s: code %d, want %d", tt.path, tt.state, rec.Code, tt.want)
		}
	}
}
