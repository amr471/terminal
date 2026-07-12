package conn

import "time"

// Clock abstracts time for the manager so staleness and backoff are testable
// with a fake clock (no sleeping tests).
type Clock interface {
	Now() time.Time
	// After behaves like time.After.
	After(d time.Duration) <-chan time.Time
}

// RealClock delegates to the time package.
type RealClock struct{}

func (RealClock) Now() time.Time                         { return time.Now() }
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
