/**
 * Placeholder command-bar symbol list for P1.5's fuzzy suggestion palette —
 * mirrors db/dev/seed.sql's four dev-seed instrument_state rows (ticker
 * only; exchange/asset-class distinctions don't matter for a suggestion
 * label). No real instrument directory is reachable from the frontend yet
 * (that's P1.6's screener query engine and/or P1.5a's live feeds +
 * persisted instrument_state) — like P1.4's placeholderFeed.ts, this is
 * meant to be deleted, not extended, once a real endpoint exists to
 * fuzzy-search against instead.
 */
export const PLACEHOLDER_COMMAND_SYMBOLS: readonly string[] = ['BTC', 'ETH', 'SOL', 'AAPL'];
