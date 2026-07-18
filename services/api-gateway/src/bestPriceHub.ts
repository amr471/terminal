/**
 * BestPriceHub (P1.7b) — the gateway's consolidated best-bid/ask engine
 * (CLAUDE.md §6.1's scalpboard.io-style view): "across all connected venues,
 * per symbol show the best bid/ask and the top-of-book size available at
 * that price, live."
 *
 * Unlike ScreenerHub (P1.6, screenerHub.ts), which polls a single Postgres
 * table, this hub combines two sources every refresh:
 *  1. `instrument_state` (Postgres) — which (exchange, symbol) pairs
 *     currently exist, i.e. "what venues list this instrument." Same table
 *     ScreenerHub already polls, queried independently here (a cheap
 *     `SELECT DISTINCT`, documented scope call — see docs/best-price.md).
 *  2. `cache:book:{exchange}:{symbol}` (Redis) — each venue's live top-of-book,
 *     written by market-data's `store.Aggregator` (docs/market-data-feeds.md).
 *     Order books are Redis-only by design (schema.md §5: never persisted to
 *     Postgres), so this is the only place that data can come from.
 *
 * Both cache-key building (`bookCacheKey`) and the JSON shape read back
 * mirror services/market-data/internal/store/state.go's `bookCache` exactly
 * ({bids, asks} as [price, qty] tuples, best-first — `store.snapshot()`
 * already sorts them, so index 0 of each side *is* the top of book, no
 * re-sorting needed here).
 *
 * Simpler than ScreenerHub in one respect: there is no per-subscriber filter
 * definition (screener.ts's `ScreenDefinition`) — every subscriber sees the
 * exact same consolidated rows, so diffing happens once per refresh against
 * one shared "last broadcast" state, and the identical delta payload goes to
 * every subscriber (each subscriber's own `subId` is stitched in by the
 * per-connection `send` closure in ws.ts, same pattern screener uses).
 *
 * No LLM, no float, on the evaluation path (CLAUDE.md prime directive):
 * cross-venue price comparison uses `compareDec` (screener.ts's exact
 * scaled-BigInt kernel) and spread uses `subtractDec` (bestPrice.ts).
 */
import { compareDec, subtractDec, bestPriceRowKey, type Dec, type BestPriceRow } from '@terminal/types';
import { pool } from './db.js';
import { redis } from './redis.js';

const SELECT_INSTRUMENT_UNIVERSE = `
  SELECT DISTINCT exchange, symbol, asset_class FROM instrument_state`;

function bookCacheKey(exchange: string, symbol: string): string {
  return `cache:book:${exchange}:${symbol}`;
}

interface BookCache {
  bids?: [string, string][];
  asks?: [string, string][];
}

function parseBookCache(raw: string | null): BookCache | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as BookCache;
  } catch {
    return null; // malformed cache entry — treat as "no data" rather than crash
  }
}

function topOfSide(levels: [string, string][] | undefined): [Dec, Dec] | null {
  const top = levels?.[0];
  if (!top) return null;
  const [price, qty] = top;
  return [price, qty];
}

/** What the hub sends a subscriber. `send` is provided by the WS layer and
 * closes over the socket + the client's subscription id. */
export type BestPriceSend = (payload: Record<string, unknown>) => void;

function signature(r: BestPriceRow): string {
  return [
    r.bestBid,
    r.bestBidVenue,
    r.bestBidSize,
    r.bestAsk,
    r.bestAskVenue,
    r.bestAskSize,
    r.venueCount,
  ].join('|');
}

/** Default order: tightest spread first (the primary scalping use case —
 * where's the liquidity worth acting on right now), nulls (no computable
 * spread yet) last, ties broken alphabetically for a stable order. */
function sortRows(rows: BestPriceRow[]): BestPriceRow[] {
  return [...rows].sort((a, b) => {
    if (a.spread === null && b.spread === null) return a.symbol.localeCompare(b.symbol);
    if (a.spread === null) return 1;
    if (b.spread === null) return -1;
    const cmp = compareDec(a.spread, b.spread);
    return cmp !== 0 ? cmp : a.symbol.localeCompare(b.symbol);
  });
}

export class BestPriceHub {
  private rows = new Map<string, BestPriceRow>();
  private order: string[] = [];
  private lastSig = new Map<string, string>();
  private lastOrder: string[] = [];
  private readonly subs = new Set<BestPriceSend>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(intervalMs = 2000, log: (msg: string, err?: unknown) => void = () => {}) {
    this.intervalMs = intervalMs;
    this.log = log;
  }

  /** Begin polling. Idempotent; the interval is unref'd so it never keeps the
   * process (or a test run) alive on its own. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reload the universe from Postgres + top-of-book from Redis, recompute
   * consolidated rows, then push a delta if anything changed. A failed load
   * keeps the previous rows (degrade, don't crash — CLAUDE.md: every feed is
   * assumed unreliable). */
  async refresh(): Promise<void> {
    try {
      const universe = await this.loadUniverse();
      const next = await this.consolidate(universe);
      this.rows = next.rows;
      this.order = next.order;
    } catch (err) {
      this.log('bestprice: refresh failed; keeping previous rows', err);
    }
    this.pushDelta();
  }

  private async loadUniverse(): Promise<
    Map<string, { assetClass: string; exchanges: string[] }>
  > {
    const result = await pool.query<{ exchange: string; symbol: string; asset_class: string }>(
      SELECT_INSTRUMENT_UNIVERSE,
    );
    const bySymbol = new Map<string, { assetClass: string; exchanges: string[] }>();
    for (const r of result.rows) {
      let entry = bySymbol.get(r.symbol);
      if (!entry) {
        entry = { assetClass: r.asset_class, exchanges: [] };
        bySymbol.set(r.symbol, entry);
      }
      entry.exchanges.push(r.exchange);
    }
    return bySymbol;
  }

  private async consolidate(
    universe: Map<string, { assetClass: string; exchanges: string[] }>,
  ): Promise<{ rows: Map<string, BestPriceRow>; order: string[] }> {
    // One batched MGET for every (exchange,symbol) book key in the universe,
    // rather than a round trip per venue per symbol — keeps this off the hot
    // path even with hundreds of instruments (CLAUDE.md prime directive).
    const keyPlan: { symbol: string; exchange: string; key: string }[] = [];
    for (const [symbol, entry] of universe) {
      for (const exchange of entry.exchanges) {
        keyPlan.push({ symbol, exchange, key: bookCacheKey(exchange, symbol) });
      }
    }

    const values = keyPlan.length > 0 ? await redis.mget(...keyPlan.map((k) => k.key)) : [];

    const booksBySymbol = new Map<string, { exchange: string; book: BookCache }[]>();
    keyPlan.forEach((plan, i) => {
      const book = parseBookCache(values[i] ?? null);
      if (!book) return;
      const list = booksBySymbol.get(plan.symbol) ?? [];
      list.push({ exchange: plan.exchange, book });
      booksBySymbol.set(plan.symbol, list);
    });

    const rows = new Map<string, BestPriceRow>();
    for (const [symbol, entry] of universe) {
      rows.set(symbol, this.buildRow(symbol, entry.assetClass, booksBySymbol.get(symbol) ?? []));
    }
    const order = sortRows([...rows.values()]).map((r) => r.symbol);
    return { rows, order };
  }

  private buildRow(
    symbol: string,
    assetClass: string,
    books: { exchange: string; book: BookCache }[],
  ): BestPriceRow {
    let bestBid: Dec | null = null;
    let bestBidSize: Dec | null = null;
    let bestBidVenue: string | null = null;
    let bestAsk: Dec | null = null;
    let bestAskSize: Dec | null = null;
    let bestAskVenue: string | null = null;
    let venueCount = 0;

    for (const { exchange, book } of books) {
      const bid = topOfSide(book.bids);
      const ask = topOfSide(book.asks);
      if (bid || ask) venueCount += 1;
      if (bid) {
        const [price, qty] = bid;
        if (bestBid === null || compareDec(price, bestBid) > 0) {
          bestBid = price;
          bestBidSize = qty;
          bestBidVenue = exchange;
        }
      }
      if (ask) {
        const [price, qty] = ask;
        if (bestAsk === null || compareDec(price, bestAsk) < 0) {
          bestAsk = price;
          bestAskSize = qty;
          bestAskVenue = exchange;
        }
      }
    }

    const spread = bestBid !== null && bestAsk !== null ? subtractDec(bestAsk, bestBid) : null;

    return {
      symbol,
      assetClass,
      bestBid,
      bestBidSize,
      bestBidVenue,
      bestAsk,
      bestAskSize,
      bestAskVenue,
      spread,
      venueCount,
    };
  }

  /** Synchronous read for a would-be REST snapshot — not exposed over HTTP
   * yet (no consumer needs it; the WS `bestprice.subscribe` snapshot-on-
   * subscribe already gives first paint), but keeping this small pure
   * accessor means adding one is a thin route handler later, same shape as
   * ScreenerHub.query(). */
  currentRows(): BestPriceRow[] {
    return this.order.map((symbol) => this.rows.get(symbol)).filter((r): r is BestPriceRow => !!r);
  }

  /** Register a live subscription: sends an initial snapshot immediately and
   * returns an unsubscribe function. */
  subscribe(send: BestPriceSend): () => void {
    if (this.subs.size === 0) {
      // First subscriber (or all previous ones just left): the shared
      // lastSig/lastOrder baseline may be stale relative to `this.rows` —
      // e.g. a test seeded rows via setRowsForTest() before anyone
      // subscribed, or refresh() hasn't run since the last subscriber left.
      // The snapshot this call is about to send *is* the new baseline every
      // subscriber (this one, and any that join before the next refresh)
      // now shares, so sync it here rather than waiting for the next
      // pushDelta() — otherwise the first post-subscribe delta would
      // re-announce every current row as "added".
      this.syncBaseline();
    }
    this.subs.add(send);
    send({ type: 'bestprice.snapshot', rows: this.currentRows() });
    return () => {
      this.subs.delete(send);
    };
  }

  private syncBaseline(): void {
    this.lastSig = new Map([...this.rows.values()].map((r) => [bestPriceRowKey(r), signature(r)]));
    this.lastOrder = this.order;
  }

  private pushDelta(): void {
    const nextSig = new Map<string, string>();
    const added: BestPriceRow[] = [];
    const updated: BestPriceRow[] = [];
    for (const symbol of this.order) {
      const row = this.rows.get(symbol);
      if (!row) continue;
      const sig = signature(row);
      nextSig.set(symbol, sig);
      const prev = this.lastSig.get(symbol);
      if (prev === undefined) added.push(row);
      else if (prev !== sig) updated.push(row);
    }
    const removed: string[] = [];
    for (const symbol of this.lastSig.keys()) if (!nextSig.has(symbol)) removed.push(symbol);

    const orderChanged =
      this.order.length !== this.lastOrder.length ||
      this.order.some((s, i) => s !== this.lastOrder[i]);

    this.lastSig = nextSig;
    this.lastOrder = this.order;

    // Baseline is now current regardless of whether anyone's listening —
    // only the broadcast itself is conditional on having subscribers and
    // something screenable having actually changed.
    if (this.subs.size === 0) return;
    if (added.length === 0 && updated.length === 0 && removed.length === 0 && !orderChanged) return;

    const payload = { type: 'bestprice.delta', added, updated, removed, order: this.order };
    for (const send of this.subs) send(payload);
  }

  // ---- test hooks ----
  /** Seed rows directly (tests, no Postgres/Redis). */
  setRowsForTest(rows: BestPriceRow[]): void {
    this.rows = new Map(rows.map((r) => [r.symbol, r]));
    this.order = sortRows(rows).map((r) => r.symbol);
  }

  /** Push a delta from the current (test-seeded) rows — the DB/Redis-free
   * half of refresh(). */
  pushDeltaForTest(): void {
    this.pushDelta();
  }
}

const refreshMs = Number(process.env.BESTPRICE_REFRESH_MS) || 2000;
export const bestPriceHub = new BestPriceHub(refreshMs, (msg, err) =>
  console.warn(`[api-gateway] ${msg}`, err instanceof Error ? err.message : ''),
);
