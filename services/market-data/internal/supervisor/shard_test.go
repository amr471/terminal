package supervisor

import (
	"fmt"
	"sort"
	"testing"
)

func TestShardSize(t *testing.T) {
	cases := []struct{ max, per, want int }{
		{30, 8, 3},   // MEXC-like
		{200, 9, 22}, // Binance-like
		{0, 9, 0},    // uncapped venue
		{9, 0, 0},    // unknown streams-per-symbol
		{5, 9, 1},    // cap smaller than one symbol's streams → at least 1
	}
	for _, c := range cases {
		if got := shardSize(c.max, c.per); got != c.want {
			t.Errorf("shardSize(%d,%d) = %d, want %d", c.max, c.per, got, c.want)
		}
	}
}

func TestShardCount(t *testing.T) {
	cases := []struct{ cap, size, want int }{
		{200, 3, 67}, // ceil(200/3)
		{200, 22, 10},
		{200, 0, 1},   // uncapped size
		{50, 200, 1},  // cap fits one shard
		{200, 200, 1}, // exactly one shard
	}
	for _, c := range cases {
		if got := shardCount(c.cap, c.size); got != c.want {
			t.Errorf("shardCount(%d,%d) = %d, want %d", c.cap, c.size, got, c.want)
		}
	}
}

// Stability: a symbol's shard slot must not change when other symbols are
// added or removed (only the modulus/count matters).
func TestShardIndexStableAcrossUniverseChanges(t *testing.T) {
	const count = 67
	idx := shardIndexFor("btcusdt", count)
	if idx < 0 || idx >= count {
		t.Fatalf("index %d out of range", idx)
	}
	// Same symbol, same count -> same slot, no matter what else is live.
	for i := 0; i < 100; i++ {
		if shardIndexFor("btcusdt", count) != idx {
			t.Fatal("shard index is not stable for a fixed count")
		}
	}
}

func TestAssignShardsGroupsAndSorts(t *testing.T) {
	syms := []string{"solusdt", "btcusdt", "ethusdt", "xrpusdt", "dogeusdt"}
	shards := assignShards(syms, 4)
	// Every symbol lands in exactly one shard; union == input; each sorted.
	seen := map[string]int{}
	for idx, list := range shards {
		if !sort.StringsAreSorted(list) {
			t.Errorf("shard %d not sorted: %v", idx, list)
		}
		for _, s := range list {
			seen[s]++
			if shardIndexFor(s, 4) != idx {
				t.Errorf("%s in shard %d but hashes to %d", s, idx, shardIndexFor(s, 4))
			}
		}
	}
	if len(seen) != len(syms) {
		t.Fatalf("assigned %d distinct symbols, want %d", len(seen), len(syms))
	}
	for _, s := range syms {
		if seen[s] != 1 {
			t.Errorf("%s assigned %d times", s, seen[s])
		}
	}
}

func TestAssignShardsSingleSlotWhenUncapped(t *testing.T) {
	shards := assignShards([]string{"btcusdt", "ethusdt"}, 1)
	if len(shards) != 1 || len(shards[0]) != 2 {
		t.Fatalf("uncapped assign = %v, want one shard of 2", shards)
	}
}

func TestApplyCap(t *testing.T) {
	// applyCap now PRESERVES the caller's order (P1.5f): it used to sort
	// alphabetically itself, which silently discarded a volume ranking.
	ranked := []string{"btcusdt", "ethusdt", "xrpusdt", "akeusdt", "zzzusdt"}
	if got := applyCap(ranked, 3); fmt.Sprint(got) != "[btcusdt ethusdt xrpusdt]" {
		t.Fatalf("applyCap = %v, want the first 3 IN ORDER", got)
	}
	if capped := applyCap(ranked, 0); len(capped) != 5 {
		t.Fatalf("cap 0 should be no-op, got %v", capped)
	}
	if capped := applyCap([]string{"a"}, 10); len(capped) != 1 {
		t.Fatalf("cap larger than set should be no-op")
	}
}

func TestSortedByName(t *testing.T) {
	syms := []string{"c", "a", "e", "b", "d"}
	if got := sortedByName(syms); fmt.Sprint(got) != "[a b c d e]" {
		t.Fatalf("sortedByName = %v", got)
	}
	// Must not reorder the caller's slice in place.
	if fmt.Sprint(syms) != "[c a e b d]" {
		t.Fatalf("sortedByName mutated its input: %v", syms)
	}
}

func TestPlanReconcile(t *testing.T) {
	running := map[int][]string{
		0: {"btcusdt"},            // unchanged
		1: {"ethusdt", "xrpusdt"}, // xrp will delist -> restart with just eth
		2: {"solusdt"},            // whole slot delists -> stop
	}
	desired := map[int][]string{
		0: {"btcusdt"},  // same -> no-op
		1: {"ethusdt"},  // changed -> restart
		3: {"dogeusdt"}, // new -> start
	}
	plan := planReconcile(running, desired)

	// slot 0 untouched
	if _, ok := plan.start[0]; ok {
		t.Errorf("slot 0 should not restart")
	}
	// slot 1 restarts with [ethusdt]
	if got := plan.start[1]; len(got) != 1 || got[0] != "ethusdt" {
		t.Errorf("slot 1 start = %v, want [ethusdt]", got)
	}
	// slot 3 starts
	if got := plan.start[3]; len(got) != 1 || got[0] != "dogeusdt" {
		t.Errorf("slot 3 start = %v", got)
	}
	// slots 1 and 2 stop (1 for restart, 2 for full delist)
	stop := map[int]bool{}
	for _, s := range plan.stop {
		stop[s] = true
	}
	if !stop[1] || !stop[2] || stop[0] || stop[3] {
		t.Errorf("stop = %v, want {1,2}", plan.stop)
	}
}

func TestPlanReconcileNoChange(t *testing.T) {
	m := map[int][]string{0: {"btcusdt"}, 1: {"ethusdt"}}
	if !planReconcile(m, m).empty() {
		t.Fatal("identical running/desired should yield an empty plan")
	}
}

func TestSameSymbols(t *testing.T) {
	if !sameSymbols([]string{"a", "b"}, []string{"a", "b"}) {
		t.Fatal("equal lists reported unequal")
	}
	if sameSymbols([]string{"a", "b"}, []string{"a", "c"}) {
		t.Fatal("different lists reported equal")
	}
	if sameSymbols([]string{"a"}, []string{"a", "b"}) {
		t.Fatal("different-length lists reported equal")
	}
}
