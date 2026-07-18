# Screener query engine (P1.6)

The screener is a deterministic filter engine over the market-data
`instrument_state` table (CLAUDE.md §6.1). A user composes a filter tree of
`field · operator · value` conditions joined by AND/OR groups, sorts it
(volume-desc by default), and either runs it once (REST) or subscribes to it
and receives live row-level deltas (WS). **No LLM sits on the screener's
evaluation path** — the LLM's only future role is translating a
natural-language request into a `ScreenDefinition`, which this engine then
executes.

## Where the pieces live

| Concern | Location |
| --- | --- |
| Filter model, validation, evaluation kernel | `@terminal/types` (`packages/types/src/screener.ts`) — the shared source of truth |
| In-memory working set + live diffing | `services/api-gateway/src/screenerHub.ts` |
| Saved screens + built-in presets | `services/api-gateway/src/screens.ts` (`screens` table, migration 0002) |
| Full-definition validation (envelope) | `services/api-gateway/src/screenerValidation.ts` |
| REST surface | `services/api-gateway/src/screenerRoutes.ts` |
| Live WS surface | `services/api-gateway/src/ws.ts` (screener.* branch) |

## The filter model (`@terminal/types`)

A `ScreenDefinition` is `{ version: 1, root: FilterNode, sort?, limit? }`.
A `FilterNode` is either a **group** (`{ kind: 'group', logic: 'and'|'or',
children: FilterNode[] }`) or a leaf condition — **numeric**
(`gt/gte/lt/lte/eq/neq/between` over the screener's numeric fields) or
**categorical** (`in/not_in` over `exchange` / `asset_class`).

`validateFilterNode` enforces the safety budget every definition must pass
before it is stored or executed (**depth ≤ 5, ≤ 64 nodes total**) — this
matters most for LLM-produced definitions. `validateScreenDefinition` in the
gateway wraps it with the outer-envelope checks (`version === 1`, root must be
a group, `sort.field` is a real screener field, `limit ∈ [1, 1000]`).

### Exact decimal comparison

Market values arrive as strings (`Dec`) and are compared with **scaled
BigInt**, never `float64` — `compareDec` finds the max fractional length of the
two operands, scales both to integers, and compares. `10000000` vs `9999999.9`
never loses a digit. `null` (a value the venue hasn't reported) **never
matches** any numeric operator, so a missing funding rate is never mistaken for
zero.

`runScreen(def, rows)` = filter → sort (default `volume_24h desc`, **nulls
last**) → optional limit. It is pure and independently unit-tested
(`screener.test.ts`, incl. the canonical `volume > 100M AND funding < 0 AND
change_24h < -5%`).

## The working set — polled, not firehose-fed

`ScreenerHub` holds an in-memory mirror of `instrument_state`, reloaded from
Postgres on a short interval (`SCREENER_REFRESH_MS`, default **2000 ms**)
rather than reconstructed from the `md.*` pub/sub firehose.

Rationale: the market-data aggregator already collapses raw ticks into
`instrument_state` (one row per instrument). Polling that single source of
truth keeps the gateway **decoupled from the hot numeric path** (prime
directive) and avoids re-implementing the aggregator's tick→state folding in a
second service. A couple seconds of staleness is acceptable for a screener; a
trader watching a single symbol tick-by-tick uses a `md.*` chart subscription,
not the screener. A failed poll **keeps the previous working set** (degrade,
don't crash) — every third-party feed is assumed unreliable (CLAUDE.md §2).

REST `/screener/query` reads this working set synchronously — no per-request
SQL.

## REST surface

All endpoints are session-gated (same cookie as the rest of the gateway).

```
POST /screener/query      { definition } | { screenId }   -> { rows, count }
GET  /screens                                             -> { screens }   (presets first)
POST /screens             { name, definition, sortKey? }  -> 201 { screen }
PUT  /screens/:id         { name?, definition?, sortKey? } -> { screen }
DELETE /screens/:id                                       -> { ok: true }   (soft delete)
```

Error codes: **GW-2005** invalid screen definition · **GW-2008** malformed
request · **GW-2012** screen not found.

### Saved screens vs presets

User screens are rows in the `screens` table (single-writer:
`svc_api_gateway`). The three built-in presets from CLAUDE.md §6.1 —
`high-volume-losers`, `negative-funding`, `unusual-oi` — are **code-defined**
in `screens.ts`, not seeded rows: no migration to keep in sync, no admin
surface to build yet. Their ids are prefixed `preset:` so they never collide
with the uuid ids of user screens, and `getDefinition` resolves either kind for
`/screener/query` and the WS `screenId`. `screens.is_preset` (with its
`is_preset = (user_id IS NULL)` check constraint) stays available for a future
DB-managed presets feature.

## Live WS surface

Screener subscriptions ride the **same** `/ws` endpoint as `md.*` (one
multiplexed socket per browser, architecture.md §2). The client picks a
`subId`; it is echoed back on every frame so the browser can route by
subscription.

```
Client -> gateway:
  { action: "screener.subscribe",   subId, definition } | { action: "screener.subscribe", subId, screenId }
  { action: "screener.unsubscribe", subId }

gateway -> client:
  { type: "screener.snapshot",     subId, rows }                         (once, on subscribe)
  { type: "screener.delta",        subId, added, updated, removed, order } (on each refresh that changed the result)
  { type: "screener.unsubscribed", subId }
```

On subscribe the hub sends a full `screener.snapshot`, then on each refresh
diffs the new result against what that subscriber last saw and sends a
`screener.delta` carrying **only** the rows that entered (`added`), changed
(`updated`), or left (`removed`, by `exchange|symbol` key), plus the full new
`order` array. A refresh that changed nothing screenable sends nothing. The
diff key per row is a compact signature over `asset_class` + the numeric
fields, so a change in any screenable value re-sends that row but unrelated
churn does not.

Limits: **10 screener subscriptions per socket**; re-using an existing `subId`
replaces that subscription. Subscriptions are torn down on socket
close/error alongside the `md.*` listeners. `screenId` resolution is scoped to
the authenticated user (a preset, or one of their own saved screens).

## Tests

- `packages/types/src/screener.test.ts` — pure kernel (compare, evaluate,
  runScreen), 9 tests, no DB.
- `services/api-gateway/src/screenerHub.test.ts` — snapshot/delta diffing via
  `setWorkingSetForTest` + `refreshForTest`, no DB, 4 tests.
- `services/api-gateway/src/ws.test.ts` — screener.subscribe snapshot +
  unsubscribe ack + GW-2005 on a bad definition (skips when local
  Postgres/Redis aren't up, same as the rest of that file).

## Not yet / scope calls

- **NL → definition** (LLM translating plain English to a `ScreenDefinition`)
  is a later AI-layer task (CLAUDE.md §6.2); the engine already accepts any
  valid definition.
- **Export with watermark/referral** (CLAUDE.md §6.1 growth mechanic) is not
  built here.
- The working set carries the columns market-data populates in
  `instrument_state`; fields it doesn't yet fill are `null` and simply never
  match numeric operators until the feed provides them.
