/**
 * ScreenerHub (P1.6) — the gateway's deterministic screener engine.
 *
 * Holds an in-memory mirror of `instrument_state` (the "working set"), reloaded
 * from Postgres on a short interval rather than reconstructed from the `md.*`
 * firehose: the market-data aggregator already collapses raw ticks into
 * `instrument_state`, so polling that single source of truth keeps the gateway
 * decoupled from the hot numeric path (prime directive) and avoids duplicating
 * the aggregator. A couple seconds' staleness is fine for a screener.
 *
 * REST `/screener/query` reads the working set synchronously (no per-request
 * SQL). Live WS subscribers get an initial snapshot and then row-level deltas
 * on each refresh — evaluation is the pure `runScreen` kernel from
 * @terminal/types; no LLM, no SQL, on the evaluation path.
 */
import { runScreen, type ScreenerRow, type ScreenDefinition, type ScreenerField } from '@terminal/types';
import { pool } from './db.js';

const SELECT_WORKING_SET = `
  SELECT exchange, symbol, asset_class,
         price::text, change_1h::text, change_24h::text, change_7d::text,
         volume_24h::text, market_cap::text, open_interest::text,
         funding_rate::text, volatility_24h::text, spread::text
  FROM instrument_state`;

const NUMERIC_FIELDS: ScreenerField[] = [
  'price',
  'change_1h',
  'change_24h',
  'change_7d',
  'volume_24h',
  'market_cap',
  'open_interest',
  'funding_rate',
  'volatility_24h',
  'spread',
];

function rowKey(r: { exchange: string; symbol: string }): string {
  return `${r.exchange}|${r.symbol}`;
}

// signature is a compact fingerprint of a row's screenable values; a change
// means the row must be re-sent to subscribers.
function signature(r: ScreenerRow): string {
  let s = r.asset_class;
  for (const f of NUMERIC_FIELDS) s += '|' + (r[f] ?? '');
  return s;
}

/** What the hub sends a subscriber. `send` is provided by the WS layer and
 * closes over the socket + the client's subscription id. */
export type ScreenerSend = (payload: Record<string, unknown>) => void;

interface Subscription {
  def: ScreenDefinition;
  send: ScreenerSend;
  lastSig: Map<string, string>;
  lastOrder: string[];
}

export class ScreenerHub {
  private rows = new Map<string, ScreenerRow>();
  private readonly subs = new Set<Subscription>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(intervalMs = 2000, log: (msg: string, err?: unknown) => void = () => {}) {
    this.intervalMs = intervalMs;
    this.log = log;
  }

  /** Begin polling instrument_state. Idempotent; the interval is unref'd so it
   * never keeps the process (or a test run) alive on its own. */
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

  /** Reload the working set from Postgres, then push deltas to subscribers. A
   * failed load keeps the previous working set (degrade, don't crash). */
  async refresh(): Promise<void> {
    try {
      const result = await pool.query(SELECT_WORKING_SET);
      const next = new Map<string, ScreenerRow>();
      for (const raw of result.rows as ScreenerRow[]) next.set(rowKey(raw), raw);
      this.rows = next;
    } catch (err) {
      this.log('screener: working-set reload failed; keeping previous', err);
    }
    this.pushDeltas();
  }

  /** Synchronous evaluation for REST /screener/query — reads the working set. */
  query(def: ScreenDefinition): ScreenerRow[] {
    return runScreen(def, [...this.rows.values()]);
  }

  /** Register a live subscription: sends an initial snapshot immediately and
   * returns an unsubscribe function. */
  subscribe(def: ScreenDefinition, send: ScreenerSend): () => void {
    const sub: Subscription = { def, send, lastSig: new Map(), lastOrder: [] };
    this.subs.add(sub);
    this.emit(sub, true);
    return () => {
      this.subs.delete(sub);
    };
  }

  private pushDeltas(): void {
    for (const sub of this.subs) this.emit(sub, false);
  }

  private emit(sub: Subscription, initial: boolean): void {
    const result = runScreen(sub.def, [...this.rows.values()]);
    const order = result.map(rowKey);

    if (initial) {
      sub.lastSig = new Map(result.map((r) => [rowKey(r), signature(r)]));
      sub.lastOrder = order;
      sub.send({ type: 'screener.snapshot', rows: result });
      return;
    }

    const nextSig = new Map<string, string>();
    const added: ScreenerRow[] = [];
    const updated: ScreenerRow[] = [];
    for (const r of result) {
      const k = rowKey(r);
      const sig = signature(r);
      nextSig.set(k, sig);
      const prev = sub.lastSig.get(k);
      if (prev === undefined) added.push(r);
      else if (prev !== sig) updated.push(r);
    }
    const removed: string[] = [];
    for (const k of sub.lastSig.keys()) if (!nextSig.has(k)) removed.push(k);

    const orderChanged =
      order.length !== sub.lastOrder.length || order.some((k, i) => k !== sub.lastOrder[i]);

    sub.lastSig = nextSig;
    sub.lastOrder = order;

    if (added.length === 0 && updated.length === 0 && removed.length === 0 && !orderChanged) return;
    sub.send({ type: 'screener.delta', added, updated, removed, order });
  }

  // ---- test hooks ----
  /** Seed the working set directly (tests, no DB). */
  setWorkingSetForTest(rows: ScreenerRow[]): void {
    this.rows = new Map(rows.map((r) => [rowKey(r), r]));
  }

  /** Push deltas from the current (test-seeded) working set — the DB-free half
   * of refresh(), so delta logic can be tested without Postgres. */
  async refreshForTest(): Promise<void> {
    this.pushDeltas();
  }
}

const refreshMs = Number(process.env.SCREENER_REFRESH_MS) || 2000;
export const screenerHub = new ScreenerHub(refreshMs, (msg, err) =>
  console.warn(`[api-gateway] ${msg}`, err instanceof Error ? err.message : ''),
);
