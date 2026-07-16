// Package supervisor runs the dynamic instrument universe (P1.5c): it polls
// each venue's Instruments() to discover listings/delistings, shards the
// symbol set across multiplexed connections sized by the venue's stream
// budget, and starts/stops feed managers at runtime as symbols come and go.
//
// This file holds the pure sharding math — no network, no goroutines — so the
// placement rules are unit-testable in isolation. The runtime lifecycle lives
// in supervisor.go.
package supervisor

import (
	"hash/fnv"
	"sort"
)

// shardSize is how many symbols fit on one multiplexed connection for a venue:
// MaxStreamsPerConn / StreamsPerSymbol. 0 means "no per-connection stream cap"
// (all symbols share one connection, still bounded by the discovery cap).
func shardSize(maxStreamsPerConn, streamsPerSymbol int) int {
	if maxStreamsPerConn <= 0 || streamsPerSymbol <= 0 {
		return 0
	}
	if n := maxStreamsPerConn / streamsPerSymbol; n >= 1 {
		return n
	}
	return 1
}

// shardCount is the fixed number of shard slots for a venue, derived from the
// discovery CAP (not the current symbol count) so a symbol's shard slot is
// stable as the universe grows or shrinks — a listed/delisted symbol only
// disturbs the one shard it hashes into, never the whole venue. A size of 0
// (uncapped) or a cap that fits in one shard collapses to a single slot.
func shardCount(capSymbols, size int) int {
	if size <= 0 || capSymbols <= size {
		return 1
	}
	return (capSymbols + size - 1) / size // ceil(cap/size)
}

// shardIndexFor maps a symbol to a stable shard slot in [0,count) by hash, so
// membership doesn't depend on which other symbols are currently live.
func shardIndexFor(symbol string, count int) int {
	if count <= 1 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(symbol))
	return int(h.Sum32() % uint32(count))
}

// assignShards groups symbols into their stable shard slots, returning only
// non-empty shards keyed by slot index. Each shard's symbol list is sorted for
// a deterministic subscribe order and stable equality checks.
func assignShards(symbols []string, count int) map[int][]string {
	out := map[int][]string{}
	for _, s := range symbols {
		idx := shardIndexFor(s, count)
		out[idx] = append(out[idx], s)
	}
	for _, list := range out {
		sort.Strings(list)
	}
	return out
}

// applyCap deterministically limits a venue's symbol set to at most n
// (MAX_SYMBOLS_PER_VENUE). Sorting first means the same subset is chosen every
// cycle, so the cap doesn't itself cause churn. n<=0 means no cap.
func applyCap(symbols []string, n int) []string {
	if n <= 0 || len(symbols) <= n {
		return symbols
	}
	sorted := append([]string(nil), symbols...)
	sort.Strings(sorted)
	return sorted[:n]
}

// sameSymbols reports whether two sorted symbol lists are equal (used to
// decide whether a shard's membership actually changed).
func sameSymbols(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// shardPlan is the set of runtime changes one discovery cycle implies: which
// shard slots to (re)start with which symbols, and which to stop. A membership
// change appears in both (stop the old, start the new) — the stable hash
// sharding keeps that set as small as the listings/delistings themselves.
type shardPlan struct {
	start map[int][]string
	stop  []int
}

func (p shardPlan) empty() bool { return len(p.start) == 0 && len(p.stop) == 0 }

// planReconcile diffs the currently-running shards (slot -> its symbols)
// against the desired assignment and returns the minimal start/stop plan.
// Pure — no goroutines — so the placement rules are unit-tested directly.
func planReconcile(running, desired map[int][]string) shardPlan {
	plan := shardPlan{start: map[int][]string{}}
	for slot, cur := range running {
		want, ok := desired[slot]
		if !ok {
			plan.stop = append(plan.stop, slot) // delisted every symbol in this slot
			continue
		}
		if !sameSymbols(cur, want) {
			plan.stop = append(plan.stop, slot) // membership changed: restart
			plan.start[slot] = want
		}
	}
	for slot, want := range desired {
		if _, ok := running[slot]; !ok {
			plan.start[slot] = want // brand-new shard
		}
	}
	return plan
}
