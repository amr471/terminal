# Consolidated best price / top-of-book (P1.7b)

A scalpboard.io-style live view: across every connected venue, per symbol,
the best bid/ask and the top-of-book size available at that price
(CLAUDE.md §6.1). Depends on P1.5b's multi-venue adapters for the top-of-book
data itself; deeper cross-venue spread/arbitrage analysis is P2.2, not this.

Scope agreed with John up front (AskUserQuestion, 2026-07-17): consolidation
math runs **gateway-side** (a new hub, same shape as P1.6's ScreenerHub) over
**the full instrument universe** (not a user watchlist), surfaced as **a new
dedicated panel kind** (not folded into the existing Screener table, whose
rows are per-venue, not consolidated).

## Where the pieces live

| Concern | Location |
| --- | --- |
| `BestPriceRow` model, spread math, live WS wire contract | `@terminal/types` (`packages/types/src/bestPrice.ts`) |
| Consolidation + live diffing | `services/api-gateway/src/bestPriceHub.ts` |
| Live WS surface | `services/api-gateway/src/ws.ts` (`bestprice.*` branch) |
| Wire client generalization | `apps/web/src/lib/gatewaySocket.ts` (now feature-agnostic, was screener-only) |
| Frontend state | `apps/web/src/lib/bestPriceReducer.ts` + `useBestPriceSubscription.ts` |
| Table + panel | `@terminal/ui`'s `BestPriceTable` (`packages/ui/src/components/BestPriceTable.tsx`) + `apps/web/src/components/BestPricePanel.tsx` |

## Why the row shape differs from the screener's

The screener's `instrument_state` rows are per **(exchange, symbol)** — one
row per venue, by design (P1.6/docs/screener.md). This view needs the
opposite grouping: one row per **symbol**, with the winning venue folded in
as a field (`bestBidVenue`/`bestAskVenue`). Both read from the same
underlying sources, just consolidated differently — `bestPriceRowKey` is the
bare `symbol`, not `exchange|symbol`.

## Where the data comes from

Order books are **Redis-only** by design (schema.md §5: "books live in Redis
`cache:book:*`, Postgres only gets derived series" — never revisit without
also revisiting that decision). So unlike the screener's `runScreen` kernel
(a pure function over Postgres-sourced rows), `BestPriceHub.refresh()`
combines two sources every poll tick (`BESTPRICE_REFRESH_MS`, default 2000ms,
same default as `SCREENER_REFRESH_MS`):

1. `SELECT DISTINCT exchange, symbol, asset_class FROM instrument_state` —
   the current universe: which venues list which symbols. A second,
   independent poll of the same table ScreenerHub already polls (a
   documented scope call — cheap indexed query, not worth threading a shared
   cache between two hubs for an MVP feature).
2. One batched `MGET` across every `cache:book:{exchange}:{symbol}` key the
   universe implies (hundreds of keys, one Redis round trip — never a
   request-per-symbol loop, CLAUDE.md's hot-path directive). Each value is
   `store.go`'s `bookCache` JSON (`services/market-data/internal/store/
   state.go`): `{bids, asks}` as `[price, qty]` tuples, **already sorted
   best-first** by `store.snapshot()`, so index `0` of each side *is* the
   top of book — no re-sorting needed gateway-side.

For each symbol, the winning bid is the **highest** bid price across
contributing venues; the winning ask is the **lowest** ask price. Both
comparisons use `compareDec` (screener.ts's exact scaled-BigInt kernel) —
never float, same as every other price comparison in this codebase.
`spread = bestAsk - bestBid` uses `subtractDec` (bestPrice.ts, same
scaled-BigInt approach, kept as its own small private helper rather than a
shared decimal-math module — same "each module's decimal helpers stay
private and self-contained" precedent screener.ts set with `compareDec`).

A symbol with no live book data anywhere (feed down, or a brand-new listing
that hasn't warmed up) still gets a row — all `null` fields, `venueCount: 0`
— rendered as `—` client-side (`NumCell`'s existing null convention), never
dropped. Same graceful-degradation stance the screener's derived stats
(`change_24h` etc., legitimately `null` for the first ~24h) already take.

## Live WS wire contract

Rides the same `/ws` socket as everything else (architecture.md §2), a new
`bestprice.*` action prefix parallel to `screener.*`:

```json
{ "action": "bestprice.subscribe", "subId": "b1" }
{ "action": "bestprice.unsubscribe", "subId": "b1" }
```

```json
{ "type": "bestprice.snapshot", "subId": "b1", "rows": [ ... ] }
{ "type": "bestprice.delta", "subId": "b1", "added": [...], "updated": [...], "removed": ["ethusdt"], "order": ["btcusdt", "solusdt"] }
{ "type": "bestprice.unsubscribed", "subId": "b1" }
```

**Simpler than screener's own wire contract in one respect**: there is no
`definition`/`screenId` to pass — `bestPriceHub.ts` has no per-subscriber
filter, so every subscriber sees the exact same consolidated rows. The hub
diffs **once per poll tick** against one shared "last broadcast" baseline and
broadcasts an identical delta payload to every subscriber (each subscriber's
own `subId` is stitched in by the per-connection `send` closure in `ws.ts`,
same pattern `screener.subscribe` already uses). `MAX_BESTPRICE_SUBS = 10`
per socket, mirroring `MAX_SCREENER_SUBS`.

## Default order

`order` is **tightest spread first** (nulls — no computable spread yet —
last, ties broken alphabetically by symbol): the primary scalping use case is
"where's the liquidity worth acting on right now." Computed server-side,
adopted verbatim client-side — same "the live WS delta's `order` array is the
single source of truth for row order" stance `ScreenerTable.tsx` documents
for its own reasons (avoiding client/server order divergence). There is no
sortable-column click handler on `BestPriceTable` for MVP — a deliberate
scope call, matching the "fixed column set, no filter builder, no export"
simplifications this panel makes relative to `ScreenerPanel`. Column config
(à la P1.7 UI's `columnConfig.ts`) is a fair follow-up if wanted; not built
here.

## `gatewaySocket.ts` generalization

The P1.7 UI version of this file was deliberately scoped to `screener.*`
only, with a note that further multiplexing "isn't built until a consumer
needs it." This is that consumer: `GatewaySocket.subscribe()` is now generic
over any feature's `{subId, ...}`-shaped messages and its own runtime frame
guard, with `subscribeScreener()` kept as a thin wrapper (unchanged public
signature — `useScreenerSubscription.ts` needed no edits) and a new
`subscribeBestPrice()` alongside it. Both ride the identical reconnect/
backoff/resubscribe-on-reconnect machinery, one socket per browser tab.

## UI surface

A new `TerminalPanelKind` (`'bestprice'`, `packages/types/src/layout.ts`),
rendered by `BestPricePanel` (thinner than `ScreenerPanel`: just a health
badge + the live table — no saved-screens picker, filter builder, column
config, or export, since there's nothing to configure). Reachable via the
command bar's new `BEST` function (`packages/ui/src/command.ts`,
`e.g. BEST` — bare function only, same as `CHART`/`NEWS`/`SCREEN`; a
`SYMBOL BEST` combo still shows "not built yet," matching those three's own
documented scope, since there's no per-instrument view yet).

**Scope call, flagged for John**: there is still no "add a panel to an
existing saved layout" UI anywhere in the app (P1.3/P1.3c only ever built
resize/reorder/move-**between**-existing-columns). Without one, a brand-new
panel kind is unreachable for any user with an already-saved layout. The
pragmatic fix taken here — same reasoning P1.3's original default served —
is adding a third column to `defaultLayoutDefinition()` carrying the
`bestprice` panel, so a fresh tab shows it immediately (existing saved
`layouts` rows are untouched). Revisit if John would rather this ship
opt-in-only until a real "add panel" feature exists.

## Real-browser bug found + fixed: column widths jumping while scrolling

John's first live look surfaced a real bug: scrolling through the board made
column widths visibly jump, sometimes to the point rows appeared empty.
Root cause — `BestPriceTable`'s `<table>` used the CSS default
`table-layout: auto`, which sizes each column from the *currently-mounted*
rows only. With virtualization that's a ~20-row slice out of a universe that
can run into the hundreds, and symbol/venue string lengths vary enormously
across that full set (`btc` vs `amdstockusdt`, `BYBIT` vs `—`) — so every
scroll event swaps which rows are mounted, the browser reflows every column
to fit the new subset, and a cell can visually collapse mid-scroll.

Fixed with `table-layout: fixed` (`.t-screener__table--fixed`, new modifier
class, applied only to `BestPriceTable` — `ScreenerTable` is untouched,
scope kept to what was actually reported) plus an explicit `<colgroup>` of
pixel widths (`COLUMN_WIDTH_PX` in `BestPriceTable.tsx`) for every column
except `symbol`, which is left unset so it absorbs whatever space the fixed
columns don't claim. Cell text also gets `overflow: hidden; white-space:
nowrap; text-overflow: ellipsis` — without it, a fixed-width column narrower
than its content would wrap instead of truncate, growing a row past the
virtualizer's fixed `rowHeightPx` assumption and desyncing the spacer-row
math (`visibleRange`, `virtualize.ts`) — the likely explanation for rows
disappearing outright, not just resizing.

## Real-browser bug found + fixed: panel resize handle stuck

Fixing the column-width jump above introduced a real side effect: the
`table-layout: fixed` columns gave the table a genuine minimum content width
(~700px+, the sum of the fixed columns), and flex items default to
`min-width: auto` — their content's natural size — so the resize handle
could no longer drag the Best Price panel narrower than that. Before the
fix, `table-layout: auto` had no intrinsic minimum, so shrinking always
"worked" (it just reflowed badly, which was the original bug). Fixed with
`min-width: 0` on `.t-screener` and `.t-screener__table-wrap` — both are
flex items in the chain between the resizable panel and `.t-screener__scroll`
(which already had `overflow: auto`), so the panel can now shrink freely and
the table gets its own horizontal scrollbar instead of refusing to shrink.
Shared classes with `ScreenerPanel`, so this also just fixes a latent (never
externally visible, since ScreenerTable had no intrinsic minimum width
either) gap there.

## Real bug found in cache:book data — root cause confirmed and fixed (2026-07-17)

John's browser screenshot showed every row with a negative spread (best bid
above best ask — impossible for a healthy book). Traced to the source with
`docker exec -it terminal-redis redis-cli GET cache:book:bybit:btcusdt`: the
raw JSON already has the crossed book — `bids[0]` = `62859.50` (correctly
the max of a properly-descending list) but `asks[0]` = `62849.90`, an
orphaned low level sitting *below* the real ask cluster (`62854.90` up
through `62867.00`), clearly a stale price level that should have been
deleted. `BestPriceHub`'s consolidation math (`compareDec`-based max-bid/
min-ask, unit-tested) and the Go-side sort (`store.snapshot()`, confirmed by
reading the code) are both faithfully reporting this — the bug was neither
of those, it was upstream in the book mirror itself.

**Real root cause** (not the dropped-delta theory first floated): `internal/
store/book.go`'s `localBook` keyed each side's price levels by the *raw wire
string*, not a canonicalized numeric value. A venue can serialize the same
price with a different number of trailing fractional zeros across messages
— e.g. a snapshot sends `"62849.90"`, and a later delta deletes that exact
level but spells the price `"62849.9"`. Keyed by raw string, those are two
different map entries: the delete silently misses its target, and the
original `"62849.90"` level is orphaned forever (not just until the next
message, which is what the file's original doc comment assumed for *any*
missed apply — true for a missed update, false for a missed deletion).

**Fixed** by adding `canonicalPriceKey()` — strips leading zeros, a
redundant `+`, and trailing fractional zeros via pure string manipulation
(no float parsing, consistent with CLAUDE.md's string-decimal convention) —
and using its output as the map key for both inserts and deletes in
`applySide()`. Added `TestLocalBook_DeleteMatchesDifferentTrailingZeroFormat`
(reproduces the exact scenario: snapshot at `"62849.90"`, delta deletes at
`"62849.9"`, asserts the level is actually gone) and `TestCanonicalPriceKey`
(9 cases covering zero-padding, sign, and the trailing-zero collapse).
`go test ./... -race` across every `services/market-data` package: all pass,
0 fail. One visible side effect: `cache:book:*` price strings now render in
canonical (minimal) form — e.g. `"62849.9"` rather than however many
trailing zeros a given exchange message happened to include — which matches
the same trim-trailing-zeros philosophy `bestPrice.ts`'s `subtractDec` fix
already established on the frontend side, not a new inconsistency.

## Venue columns narrowed to give the symbol more room (2026-07-17)

John: the table felt "folded" on the right, and he'd rather see the coin
name than the exchange. Narrowed `bestBidVenue`/`bestAskVenue` from 84px to
56px in `BestPriceTable.tsx`'s `COLUMN_WIDTH_PX` — `symbol` is the one
column left unset (it flexes to absorb whatever the fixed columns don't
claim), so the reclaimed space goes straight to it. Venue names are still
fully readable on hover via `MarqueeText`; at rest they're already
secondary-colored/label-sized (`.t-screener__venue`) so no further visual
de-emphasis was layered on top of the width change.

## Real bug found + fixed: symbol column could render at ~0px width (2026-07-18)

Same root cause as `docs/screener-ui.md`'s matching section (read that one
for the full CSS explanation): `symbol` being left unset in `COLUMN_WIDTH_PX`
so it could "flex" into leftover space only works when there IS leftover
space, and the previous entry's fix (narrowing the venue columns) made that
worse, not better, once the panel itself is narrow — with `table-layout:
fixed`, a table's width only grows to fit its *explicitly widthed* columns,
so `symbol` could get 0px in a narrowed panel regardless of how much room
the other columns gave up to it. Fixed the same way as ScreenerTable: `symbol`
now has a real 120px width, and `terminal.css`'s new sticky-left first-column
rule (shared `.t-screener__table--fixed` class) keeps it visible while
`bestBid`/`bestAsk`/etc. scroll underneath. Verified: `tsc --noEmit` clean,
`@terminal/ui`'s 58/58 tests green, `eslint` clean.

**Product question raised alongside the bug, not yet acted on:** John asked
why this panel (right column of the default layout) exists at all given the
Screener (left column) is already there, since both looked equally cramped
before the fix above. Answered in chat, recorded here for continuity: the
two tables answer different questions and aren't actually redundant —
Screener is one row per **(exchange, symbol) pair**, filterable/sortable
across every metric, built for *discovering* instruments ("find me
high-volume negative-funding coins, across every venue that lists them").
This panel is one row per **symbol**, consolidated across every venue, built
for *execution* ("I already know I want BTC — which connected venue has the
tightest spread right now"). `defaultLayoutDefinition()` gives both equal
1-unit columns, which is what made both feel cramped at once; whether that
default should change (give this panel more width, since it inherently has
fewer columns than Screener, or dock it somewhere else) is still open —
John should look again now that the invisible-symbol bug is fixed before
deciding whether the layout itself needs to change too.

## Product decision: dropped from the default layout, replaced by a Screener-row click-through (2026-07-18)

Following up on the open question above: John looked at real reference
screenshots of a third-party funding-rate arbitrage scanner (a list view
plus a per-symbol "Chart-Spread" detail page) and said the persistent
right-hand panel felt "awkward" and asked why it was needed at all "if you
need a spread, you can have a person click on the desired coin in this list
and a similar page opens in a new tab." Two different-sized changes were
tangled in that one message — a full arbitrage-scanner rebuild (real Phase-2
scope, CLAUDE.md §10) vs. simply removing the side panel and adding a
click-through — so this was posed back via `AskUserQuestion` rather than
guessed. John picked the small option both times: **drop the panel, no new
backend math, ships same day.**

What actually changed:

- `defaultLayoutDefinition()` (`packages/types/src/layout.ts`) is back to
  P1.3's original 2 columns (Screener | Chart+News) — the third `bestprice`
  column added at P1.7b is gone. `'bestprice'` stays in
  `TERMINAL_PANEL_KINDS`; `BestPricePanel`/`BestPriceTable` are unchanged
  and still fully live. **Existing saved tabs are untouched** — this only
  changes what a *new* tab starts with, same as every previous
  `defaultLayoutDefinition()` change.
- `BestPricePanel` gained an optional `symbolFilter?: string` prop — filters
  the same full-universe live `rows` client-side to one symbol. No wire
  protocol change; `bestPriceHub.ts` still has no per-subscriber filter, by
  design (every subscriber gets the same consolidated stream).
- `ScreenerTable` (`@terminal/ui`) gained an optional `onSymbolClick?:
  (symbol: string) => void` prop. When set, rows become clickable
  (`role="button"`, `tabIndex=0`, Enter/Space activate) with a
  `t-screener__row--clickable` cursor + focus-ring affordance
  (`terminal.css`). `ScreenerPanel` wires it to
  `window.open(\`/${locale}/terminal/symbol/${symbol}\`, '_blank')` — a
  **real new browser tab**, not P1.3a's internal workspace-tab strip; this
  is a one-off detail view, not a saved layout.
- New route: `apps/web/src/app/[locale]/terminal/symbol/[symbol]/page.tsx`.
  Session-gated with the exact same `/auth/me` cookie-forward pattern
  `terminal/page.tsx` uses (fetch wrapped in try/catch, `redirect()` called
  outside the catch). Deliberately **not** the full terminal shell — no
  `IconRail`/`TerminalCommandBar`/`TerminalTabs` — just a back link, a
  title, and `<BestPricePanel symbolFilter={symbol} />`, reusing
  `terminal-shell.css`'s layout wrapper classes (already loaded for the
  whole `[locale]` segment) for a consistent look with two new page-specific
  classes (`t-symbol-detail__back`/`__title`).
- New i18n keys `bestprice.symbol_detail.title` / `bestprice.symbol_detail.back`
  in both `en.ts` and `ru.ts`.

Verified: `tsc --noEmit` clean for `@terminal/types`/`@terminal/ui`/
`@terminal/web`; `@terminal/types` 31/31 and `@terminal/ui` 58/58 tests
green; `eslint` clean for `@terminal/ui` and `@terminal/web`. Not yet
verified on a real browser (click-through navigation, new-tab auth
round-trip, RU copy) — flag for John's next live pass.

**Explicitly out of scope, per John's own answer:** the full funding-rate
arbitrage scanner (Buy/Sell venue pairs, Fund/1d/7d/30d columns, F Spread
APR, a spread-over-time chart) from the reference screenshots. That's real
Phase-2 "market-intelligence edge" work (CLAUDE.md §10) — cross-venue
spreads/arbitrage, not this. If it's picked up later it should get its own
doc rather than folding into this one.

**Follow-up, same day:** John also asked why the new detail page has no
spread chart (the second reference screenshot). Investigated before
building anything: no gateway route reads the `candles` hypertable that
`services/market-data` already writes (grepped — zero candle/kline/ohlc
routes), and `apps/web` has no charting library installed at all. That's
squarely **P1.8 "Charts"** (`TASKS.md`, unstarted), not something to
improvise inside this page. Asked via `AskUserQuestion`; **he chose "Skip
for now"** — the symbol-detail page stays the price table only until P1.8
comes up in the normal roadmap order.

## Venue badges link out to the real exchange (2026-07-18)

Follow-up ask on the new symbol-detail page: clicking a venue name should
open that exchange's actual trading page for this symbol, not just display
the badge. `packages/types/src/exchangeLinks.ts`'s `exchangeTradeUrl(venue,
symbol)` is a pure per-venue URL template, verified against each of the
eight venues' real URL scheme via live web search 2026-07-18 (not guessed —
see the file's per-case comments for the confirmed pattern each was checked
against). Every tracked symbol is USDT-margined-perp and normalized to
lowercase base+quote concatenated with no separator (`norm.NormalizeSymbol`,
services/market-data), so the one non-trivial join point is KuCoin's BTC→XBT
rename + `M` suffix (`kucoinWireSymbol`), ported from
`services/market-data/internal/exchange/kucoin/kucoin.go`'s `wireSymbol`
since that mapping is Go-only and wasn't reachable from the frontend.
Unrecognized venue strings return `null` rather than a guessed/broken URL —
`BestPriceTable`'s `bestBidVenue`/`bestAskVenue` cells fall back to a plain
badge in that case.

`BestPriceTable`'s venue badges are now `<a target="_blank">` when a URL
resolves, `title` set to the new `common.open_on_exchange` i18n key
(shared with `ScreenerTable`'s matching exchange-cell link, see
docs/screener-ui.md), `.t-screener__venue--link` (terminal.css) resets the
browser's default link color/underline to match the existing badge look,
adding an underline only on hover/focus as the click affordance.

Verified: `@terminal/types` 41/41 (was 31, +10 new `exchangeTradeUrl`
tests), `tsc --noEmit`/`eslint` clean across `@terminal/types`/
`@terminal/ui`/`@terminal/web`.

## Testing

- `bestPrice.test.ts` (`@terminal/types`) — `subtractDec` exactness, the
  `symbol`-only row key, and the frame guard accepting real frames /
  rejecting malformed ones (including a float leaking into a `Dec` field).
- `bestPriceHub.test.ts` (api-gateway) — pure diffing tests via
  `setRowsForTest`/`pushDeltaForTest` (no Postgres/Redis needed), covering:
  initial snapshot order, a changed value broadcasting identically to every
  subscriber, silence when nothing screenable changed, added/removed on
  universe changes, per-subscriber unsubscribe, and an all-null row for a
  symbol with no live book data. Importing the hub pulls in the shared Redis
  client as a module side effect even though these tests never call
  `refresh()`, so the test file explicitly `redis.disconnect()`s in an
  `after()` hook — same process-hang footgun `pubsub.test.ts` already
  documents and fixes the same way.
- `ws.test.ts` — two new end-to-end cases (`bestprice.subscribe` snapshot +
  unsubscribe ack; a malformed subscribe returns `GW-2008`), skip-if-no-DB
  like every other WS test in this file.
- `bestPriceReducer.test.ts` (apps/web) — snapshot-replaces / delta-merges /
  transient-race-skip / empty-clears, mirroring `screenerReducer.test.ts`.

Sandbox-verified (no Docker, so DB/Redis-backed tests skip gracefully):
`@terminal/types`, `@terminal/ui`, `@terminal/i18n`, `api-gateway`, and
`apps/web` all `tsc`/`eslint` clean; every pure-logic test suite passes for
real. Box stays unchecked in TASKS.md pending John's real
`dev:up`/`dev:migrate`/`turbo run test --force` + browser pass, same
verification workflow every prior P1.x task followed.
