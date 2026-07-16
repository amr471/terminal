package kucoin

import "strconv"

// nsToMs converts a KuCoin timestamp to ms epoch. Futures execution/depth
// timestamps are nanoseconds; guard against a value that is already ms (or
// seconds) so a unit change on KuCoin's side degrades to a plausible time
// rather than a garbage one. Thresholds are decade-wide, well clear of real
// epoch values.
func nsToMs(v int64) int64 {
	switch {
	case v > 1e18: // nanoseconds
		return v / 1_000_000
	case v > 1e15: // microseconds
		return v / 1_000
	case v > 1e11: // already milliseconds
		return v
	case v > 0: // seconds
		return v * 1_000
	default:
		return v
	}
}

// bucketMs parses a candle's time field (string) to ms epoch, tolerating a
// seconds-vs-ms unit ambiguity. Used both for the envelope ts and as the
// rollover key, so it only needs to be monotonic and roughly correct.
func bucketMs(s string) int64 {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	if v > 0 && v < 1e12 { // seconds
		return v * 1_000
	}
	return v
}
