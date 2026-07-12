// Package health implements the §5.5 contract: per-feed states, worst-of
// aggregation, the health:{service} Redis heartbeat shape, and the
// /healthz + /readyz HTTP handlers.
package health

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// State mirrors the TS HealthState union — uppercase on the wire.
type State string

const (
	StateLive     State = "LIVE"
	StateDegraded State = "DEGRADED"
	StateStale    State = "STALE"
	StateDown     State = "DOWN"
)

var severity = map[State]int{StateLive: 0, StateDegraded: 1, StateStale: 2, StateDown: 3}

// Worst returns the most severe of the given states (LIVE when empty),
// matching worstState() in @terminal/types.
func Worst(states []State) State {
	worst := StateLive
	for _, s := range states {
		if severity[s] > severity[worst] {
			worst = s
		}
	}
	return worst
}

// Report is the §5.5 JSON shape served on /healthz//readyz and written to
// health:{service}.
type Report struct {
	Status    State            `json:"status"`
	Feeds     map[string]State `json:"feeds"`
	LagMsP95  int64            `json:"lagMsP95,omitempty"`
	UpdatedAt int64            `json:"updatedAt"` // ms epoch
}

// Registry is the concurrent store of per-feed states.
type Registry struct {
	mu    sync.RWMutex
	feeds map[string]State
}

func NewRegistry() *Registry {
	return &Registry{feeds: make(map[string]State)}
}

func (r *Registry) Set(feed string, s State) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.feeds[feed] = s
}

func (r *Registry) Get(feed string) State {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s, ok := r.feeds[feed]; ok {
		return s
	}
	return StateDown
}

// Report snapshots the registry into the wire shape.
func (r *Registry) Report(now time.Time) Report {
	r.mu.RLock()
	defer r.mu.RUnlock()
	feeds := make(map[string]State, len(r.feeds))
	states := make([]State, 0, len(r.feeds))
	for name, s := range r.feeds {
		feeds[name] = s
		states = append(states, s)
	}
	return Report{Status: Worst(states), Feeds: feeds, UpdatedAt: now.UnixMilli()}
}

// Handler serves /healthz (liveness: process is up → always 200) and
// /readyz (readiness: 503 unless overall status is LIVE or DEGRADED).
func Handler(r *Registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeReport(w, r.Report(time.Now()), http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		rep := r.Report(time.Now())
		code := http.StatusOK
		if rep.Status == StateStale || rep.Status == StateDown {
			code = http.StatusServiceUnavailable
		}
		writeReport(w, rep, code)
	})
	return mux
}

func writeReport(w http.ResponseWriter, rep Report, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(rep)
}
