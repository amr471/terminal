# Screener UI (P1.7)

The frontend half of the screener (CLAUDE.md §6.13): a saved-screens/presets
picker, a filter-tree editor, a live virtualized table, column
visibility, and CSV export — built on top of P1.6's query engine and WS
delta protocol (`docs/screener.md`), which this doc assumes as background.

## Where the pieces live

| Concern | Location |
| --- | --- |
| Wire-frame types (`screener.snapshot`/`delta`/`error`) + runtime guard | `@terminal/types` (`packages/types/src/screener.ts`) |
| Windowing math, filter-tree edit ops, column-list ops | `packages/ui/src/virtualize.ts` / `filterTree.ts` / `columnConfig.ts` |
| Table + filter-tree presentational components | `packages/ui/src/components/ScreenerTable.tsx` / `FilterBuilder.tsx` |
| The app's first WS client | `apps/web/src/lib/gatewaySocket.ts` |
| Frame → row-state reducer | `apps/web/src/lib/screenerReducer.ts` |
| React hook wiring the socket + reducer together | `apps/web/src/lib/useScreenerSubscription.ts` |
| Saved-screens REST client, CSV builder | `apps/web/src/lib/screensClient.ts` / `screenerExport.ts` |
| The assembled panel | `apps/web/src/components/ScreenerPanel.tsx` |

## Live delivery: the app's first WebSocket client

`gatewaySocket.ts` connects to the same-origin `/api/ws` (proxied to the
gateway's `/ws` by `next.config.mjs`'s existing rewrite, exactly like every
other `fetch()` call already does) rather than a direct cross-origin
connection to `GATEWAY_ORIGIN` — a direct connection would not carry the
Secure session cookie (`docs/landing-page.md`'s whole reason the rewrite
exists). One socket per tab (module-level singleton), multiplexed by
`subId` per `docs/gateway-ws.md`; reconnects with capped exponential
backoff (`backoffDelayMs`, 1s → 30s cap, no jitter — a single tab
reconnecting isn't the thundering-herd failure mode this guards against)
and transparently re-sends every active subscription on reconnect, so a
dropped connection is invisible above `useScreenerSubscription`.

**Scope call:** the live subscription always sends an inline `definition`,
never `{screenId}`. Every saved screen's definition is already in hand from
the `/screens` list (`ScreenerPanel` loads it once on mount), so
subscribing by value means a sort-header click — which only needs to patch
`.sort` — never has to "expand" a screenId-based subscription into an
editable definition first. The `{screenId}` variant the gateway also
accepts stays available for a future caller that doesn't already hold the
definition (a Telegram mini-app view, perhaps).

**Known verification gap:** whether `next dev`'s rewrite actually proxies
the WS *upgrade* request (not just plain HTTP) for `/api/ws` has not been
exercised end to end in this sandbox — there's no Postgres/Redis/gateway
stack reachable here (same standing limitation every other P1.x doc notes).
If it turns out the rewrite doesn't forward the upgrade in dev, the
symptom will be `gatewaySocket` sitting in `connecting`/reconnect-backoff
forever; `ScreenerPanel` surfaces that as the existing `data.loading` /
`data.feed_down` badge rather than crashing, but the fix (if needed) would
be either a next.config.mjs adjustment or a dedicated WS proxy — **please
run the dev stack and confirm the screener panel actually goes `live`**
before treating this task as done.

## Draft-then-apply, except sort

Editing the filter tree (`FilterBuilder`) stages changes in a local
`pendingRoot` — only "Apply" merges it into the live `definition` and
re-subscribes. Re-subscribing on every keystroke would replace the WS
subscription (and trigger a fresh full snapshot from the hub) once per
character typed into a value box. Clicking a sort-column header bypasses
that gate and re-subscribes immediately — matching the instant-resort
expectation any spreadsheet/Bloomberg-style table sets, and cheap since it
only patches `.sort`, not the filter tree.

## Virtualization — spacer-row `<table>`, no dependency

Same house convention as `resize.ts`/`panelOrder.ts`/`tabOrder.ts`: the
windowing arithmetic (`visibleRange` in `packages/ui/src/virtualize.ts`) is
a pure, node:test-tested function; `ScreenerTable` only turns a scroll
event into a call to it. Real `<table>` markup (not a div-grid) so screen
readers still see a table — two single-cell spacer `<tr>`s absorb the
height of everything scrolled past above/below the currently-mounted slice,
the same technique used before dedicated virtualization libraries existed.
Fixed row height only (`--t-density-row`, 22px) — every row is one line of
mono-font data, so variable-height windowing's extra complexity isn't
needed.

Only real `ScreenerField`s are sortable — `symbol`/`exchange` are identity
columns `ScreenDefinition.sort` doesn't support ordering by. Letting the
client sort by an unsupported field locally would silently diverge from
the WS delta's `order` array (the actual source of truth, computed
server-side by `runScreen`) on the very next refresh.

## Column config — `localStorage`, same scope call as P1.4a

Visible/hidden columns persist per-browser under
`terminal.screener.columns`, read lazily in a `useEffect` (not a `useState`
initializer, so the first client render matches the server-rendered shell
before storage is consulted) — the same "personal display preference,
browser-local rather than account-synced" call `docs/terminal-shell.md`
documents for P1.4a's secondary clock. Syncing it to the account is a
natural, self-contained follow-up (a `users` column + a small PATCH
endpoint) whenever one exists; nothing here blocks that.

## Export — raw values, generic watermark link

**Scope call:** exported CSV cells are the raw `Dec` strings the engine
produces, not locale-formatted display text. A CSV meant to be reopened in
a spreadsheet should be exact and locale-agnostic — inserting e.g. Russian
`,` decimal separators would make the numbers ambiguous or break
re-import. Display formatting (`NumCell`) stays a screen-only concern.

**Scope call:** the watermark links to the site origin, not a personalized
`/r/<code>` referral link — `docs/schema.md` has nothing reserved for a
referral-code system yet (checked before building this), and CLAUDE.md's
"viral export... watermark/referral links" language (§6.7) is scoped to
the later marketplace/analytics export feature, not this one. Swapping in
a real code is a caller-side change to the `referralUrl`/watermark string
`ScreenerPanel` builds, not a change to `screenerExport.ts`'s CSV shape.

## Saved screens — create/select/overwrite/delete; rename deferred

`ScreenerPanel` covers picking a preset or saved screen, editing an ad-hoc
filter and saving it as new (`POST /screens`), overwriting the
currently-selected screen if it's the user's own (`PUT /screens/:id`), and
deleting it (`DELETE /screens/:id`, presets are never deletable). Renaming
a saved screen without touching its definition isn't wired up in this pass
— TASKS.md's P1.7 line names "filter builder front-end", not a full
screen-management UI, and this is a small, obvious fast-follow (the REST
endpoint already supports a name-only `PUT`) rather than a design
question worth blocking on.

## `tsconfig.test.json` gained the DOM lib

`gatewaySocket.ts` is the first `apps/web/src/lib` module referencing
browser globals (`WebSocket`, `Location`) — every prior module there was
pure enough to type-check against `base.json`'s bare `ES2022` lib alone.
`apps/web/tsconfig.test.json` (used by the package's own `test` script,
separately from the Next.js build's `tsconfig.json`, which already had the
DOM lib) now mirrors that. This only affects what compiles, not what
`node --test` executes — nothing in the test suite actually constructs a
`WebSocket`.

## Confirmed live — and a real bug the browser pass caught

**2026-07-17:** John ran `dev:web`/`dev:gateway` and confirmed the Screener
panel loads a preset and shows the `live` badge. Getting there surfaced a
genuine bug the automated suite couldn't have caught: `useScreenerSubscription.ts`
imports `gatewaySocket.ts`/`screenerReducer.ts` with the NodeNext-required
`.js` extension (see "`tsconfig.test.json` gained the DOM lib" above — this
whole `src/lib` layer inherits `@terminal/tsconfig/base.json`'s
`moduleResolution: NodeNext`, which the ESM `node --test` runtime needs).
That's the first `src/lib` module to import *another* `src/lib` module and
also be pulled into Next's real webpack graph (via `ScreenerPanel` →
`TerminalWorkspace` → `TerminalTabs`) — `tsc`'s own `bundler` resolution
(`apps/web/tsconfig.json`) already knows to resolve a `.js` specifier back
to a sibling `.ts` file, but webpack doesn't do that rewrite on its own, so
the build failed with `Module not found: Can't resolve './gatewaySocket.js'`.

Fixed with a `webpack.resolve.extensionAlias` in `next.config.mjs`
(`{'.js': ['.ts', '.tsx', '.js']}`) rather than dropping the `.js`
extensions from the source — removing them would have broken the
`node --test` path instead, since Node's ESM loader (this package is
`"type": "module"`) requires the extension to be present on the compiled
output. Re-verified both toolchains green after the fix
(`tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json && node
--test`). Any future `src/lib` file that imports a sibling `src/lib` file
inherits this fix automatically — nothing else to do per-file.

## Real-browser bug found + fixed: column widths jumping while scrolling (2026-07-17)

Once P1.7b's Best Price panel shipped alongside this table, John reported the
same table on the Screener side of the split view: "in the table on the left,
the columns also move when you scroll down." Same root cause as the fix
already applied to `BestPriceTable.tsx`: `ScreenerTable.tsx` was still plain
`table-layout: auto`, which sizes columns from only the currently-DOM-mounted
virtualized rows — with symbol strings ranging from `btc` to
`amdstockusdt` and only ~20 rows mounted out of the full universe, every
scroll swaps which rows are mounted and the browser reflows every column
width, sometimes collapsing content.

Fixed by giving `ScreenerTable` the same `table-layout: fixed` treatment: a
`COLUMN_WIDTH_PX` map (mirroring `BestPriceTable.tsx`'s) covering every
`ScreenerColumnId` except `symbol` (left unset so it absorbs remaining
space), rendered via a `<colgroup>` keyed by column id — so it stays correct
regardless of which columns the user has toggled on/off or reordered via
`columnConfig.ts` (the width lookup is by id, not position).

## Running-line reveal for clipped cell text (2026-07-17)

Same message also asked: "If the text doesn't fit in the column, I want it
to be a running line." Fixed-width columns clip long values (venue names,
long symbols) with an ellipsis, which isn't readable for e.g. `HYPERLIQ…`.
Added `MarqueeText` (`packages/ui/src/components/MarqueeText.tsx`), a small
wrapper every cell in both `ScreenerTable` and `BestPriceTable` now renders
through: on `mouseenter`, it measures whether the content actually overflows
its box (`scrollWidth > clientWidth`) and, only if so, adds a class that
CSS-animates the text scrolling left to reveal the clipped end, pausing,
then scrolling back (`terminal.css`'s `t-marquee-scroll` keyframes,
`--t-marquee-distance` set inline from the measured overflow). Deliberately
hover-triggered rather than an always-on ticker — animating every visible
row of a dense virtualized table simultaneously would be both distracting
and a real paint cost — and measured lazily per-hover rather than via a
`ResizeObserver`, so it stays correct after a panel/column resize without a
live observer per cell. Non-overflowing content (the common case) never gets
the animation class and pays nothing extra.

## Open Interest gaps and row count are expected, not a bug (2026-07-17)

Same message flagged two more things: "Open interest is not displayed
everywhere on the left, and it looks like there are very few coins on the
left... there should be more different quotes." Neither is new to this
session — both trace to already-documented P1.5b/P1.5d scope calls in
`services/market-data`:

- **OI gap:** of the eight default venues, three deliberately omit `oi` from
  `ProvidedKinds()` — KuCoin (`internal/exchange/kucoin/adapter.go`: "KuCoin's
  OI isn't wired from the channels this feed subscribes to, would need a
  separate snapshot/REST path"), MEXC (`internal/exchange/mexc/adapter.go`:
  "OI isn't wired from the channels used"), and BingX
  (`internal/exchange/bingx/adapter.go`: exposes neither funding nor OI as a
  stream). Binance/Bybit/OKX/HyperLiquid/Aster do provide it. So any row
  sourced from KuCoin/MEXC/BingX will always show `—` for Open Interest until
  one of those follow-ups lands — expected, not a bug.
- **Row count:** P1.5c's dynamic instrument universe caps each venue at
  `MAX_SYMBOLS_PER_VENUE` (default 200) and only re-discovers every
  `DISCOVERY_INTERVAL` (default 5m), so the actual row count depends on how
  long `market-data` has been running and how many venues are actually
  connected in your environment — not a fixed "should be N rows" number. To
  check what's actually populated rather than guess: `docker exec -it
  terminal-db psql -U postgres -d terminal -c "SELECT exchange, COUNT(*)
  FROM instrument_state GROUP BY exchange ORDER BY 2 DESC;"` — that shows
  exactly which venues are contributing rows and how many each has, which
  will confirm whether this is just "give discovery more time" / "some
  venues aren't connecting" versus a genuine gap worth digging into further.

No code changed for either of these two — flagging here so the reasoning is
on record rather than re-derived next time it comes up.

## Exchange quick-filter dropdown + a stale-list bug found alongside it (2026-07-17)

John asked for a dedicated exchange picker: pick one exchange from a
dropdown, instantly see every coin on it, without touching the filter
builder. Added a second `<select>` to `ScreenerPanel`'s toolbar (reusing
`FilterBuilder`'s existing `t-screener__picker` styling) backed by new local
state `exchangeFilter`. It's deliberately layered *on top of* the real
filter tree rather than living inside it: a new `withExchangeFilter(root,
exchange)` helper wraps `definition.root` in a fresh top-level AND group
alongside an `exchange in [exchange]` categorical leaf, and only the
resulting `effectiveDefinition` (computed via `useMemo`) is handed to
`useScreenerSubscription` — `pendingRoot`/`definition`/`FilterBuilder` never
see it, so switching the quick-pick never marks the screen dirty, never
affects Save/Save As, and survives switching between saved screens/presets
untouched. CSV export uses the same live `rows`, so an exported file matches
whatever's on screen including the exchange narrowing.

**Found a real, separate bug while wiring the dropdown's option list:**
`@terminal/types`' `EXCHANGES` const (`packages/types/src/market.ts`) still
had its original F0.4 list — `binance`, `bybit`, `okx`, `coinglass`,
`hyperliquid` — and was never updated when P1.5b/P1.5d added kucoin, aster,
mexc, and bingx to the live venue registry. Since `FilterBuilder`'s
categorical-value picker sources its `exchange` options straight from this
constant, the existing generic filter builder had been silently unable to
filter on 4 of the 8 real venues since the day they shipped — a genuine
contributor to "it seems like not all the coins are there," found while
addressing that exact report. Fixed by widening `EXCHANGES` to the accurate
8-venue list and dropping `coinglass` (never a real
`instrument_state.exchange` value — it's a bought data vendor per CLAUDE.md
§7, not a market-data venue). Safe to widen/narrow: every consumer types it
as `Exchange | string` (a loose union, nothing exhaustively switches on it),
confirmed via grep before changing it.

**Known edge case, not fixed:** wrapping `root` in `withExchangeFilter` adds
one depth level and two nodes on top of whatever the user's own filter tree
already used. For a screen already at `MAX_FILTER_DEPTH` (5) or very close
to `MAX_FILTER_NODES` (64), selecting an exchange could push the composed
tree over budget — the gateway would reject it (existing GW-2005 handling
in `useScreenerSubscription`, surfaced as the DEGRADED/DOWN health badge),
not silently misbehave, but it also wouldn't show a targeted "your filter is
too complex to also narrow by exchange" message. Realistic filter trees are
nowhere near either budget, so this wasn't treated as blocking — flagged
here rather than silently ignored.

## Real bug found + fixed: the symbol column could render at ~0px width (2026-07-18)

John reported that in the default 3-column layout (`defaultLayoutDefinition()`
— Screener in the left column, Chart+News in the middle, Best Price in the
right), the Screener panel's coin identity was invisible: "the names of the
coins are not visible, even when I move the gesture to the right and left."
The screenshot showed a header row starting `Exchange | PRICE | 24H% |
VOLUME 24H` with no `SYMBOL` header at all, even though `symbol` is first in
`DEFAULT_VISIBLE_COLUMNS`.

Root cause: `ScreenerTable.tsx`'s `COLUMN_WIDTH_PX` deliberately left
`symbol` unset so it would "flex" into whatever width the fixed columns
didn't claim (2026-07-17's column-jump fix, above). That reasoning only
holds when there's space left over. Per the CSS 2.1 fixed-table-layout
algorithm, a table's used width is `max(specified width, sum of the
*explicitly widthed* columns)` — an unset column isn't part of that sum, so
once the fixed columns alone (exchange 90 + price 110 + three 76px change
columns + volume_24h 110, etc.) already add up to more than a narrowed
panel's real width, `symbol` gets 0px of the remainder and genuinely
disappears — not scrolled off, not clipped, zero rendered width. The default
layout's three equal-width columns make a narrow panel the common case, not
an edge case. `BestPriceTable.tsx` had the identical pattern (`symbol` also
left unset there) and would hit the same bug under the same conditions.

Fixed in both tables: `symbol` now has a real fixed width (120px, sized for
mono 12px text up to ~14 chars plus cell padding — covers real symbols like
`1000pepeusdt`). On top of that, `terminal.css` gained a sticky-left rule for
whichever column is first (`.t-screener__table--fixed .t-screener__th:first-
child` / `.t-screener__td:first-child`), so the identity column stays
visible while the metric columns scroll underneath it — turning horizontal
scroll from "the coin name disappears no matter what" into the standard
frozen-first-column pattern these dense tables need. Verified: `tsc --noEmit`
clean in `@terminal/ui` and `apps/web`, `@terminal/ui`'s 58/58 `node --test`
suite green, `eslint` clean.

**Also raised in the same message, not yet acted on:** "why the right one
[Best Price] at all, if there is a left one [Screener]?" — a real product
question about whether the two panels are redundant, not a bug. See
`docs/best-price.md`'s matching section for the answer given.

## Row click opens an internal detail tab; exchange badge links out to the real venue (2026-07-18)

Two distinct click affordances landed on the same row this round, from two
separate asks — worth keeping straight since they target different
elements:

- **Clicking anywhere else on a row** (`onSymbolClick` on `ScreenerTable`)
  opens `/[locale]/terminal/symbol/[symbol]` in a new browser tab — our own
  cross-venue detail view. See `docs/best-price.md`'s "Product decision:
  dropped from the default layout..." section for the full story (this
  replaced the persistent Best Price side panel).
- **Clicking the `exchange` cell specifically** now opens that venue's own
  real trading page for the row's symbol in a new tab —
  `exchangeTradeUrl(venue, symbol)` (`packages/types/src/exchangeLinks.ts`,
  documented in `docs/best-price.md`'s matching section). The exchange
  cell's `onClick` calls `e.stopPropagation()` so it doesn't also trigger
  the row's `onSymbolClick`; falls back to plain text for a venue string
  `exchangeTradeUrl` doesn't recognize.

Verified: `@terminal/types` 41/41, `@terminal/ui` 58/58, `tsc --noEmit`/
`eslint` clean everywhere touched.

## Alphabetical (symbol) sort (2026-07-19)

John asked for an alphabetical option alongside the volume-desc default.
`ScreenerTable`'s doc comment used to say only real `ScreenerField`s (the
numeric filter/sort fields) were sortable — `symbol`/`exchange` were
identity columns the query engine's `ScreenDefinition.sort` didn't support
ordering by, since a client-side-only sort on an unsupported field would
silently diverge from the server's `order` array on the next live refresh.
Rather than special-case a client-only sort (which would have exactly that
bug), `symbol` became a real, server-side-recognized sort field:

- `packages/types/src/screener.ts` — new `SCREENER_SORT_FIELDS =
  [...SCREENER_FIELDS, 'symbol']` / `ScreenerSortField` type;
  `ScreenDefinition.sort.field` widened to it. `runScreen`'s comparator
  branches on `field === 'symbol'` to do a plain codepoint string compare
  (`a.symbol < b.symbol`, not `localeCompare` — symbols are always ASCII
  tickers, and a fixed compare is deterministic across locales/ICU
  versions, same "exact, no surprise" stance `compareDec` takes for the
  numeric fields) instead of `compareDec`. 2 new tests (asc + desc).
- `services/api-gateway/src/screenerValidation.ts` — `sort.field`'s
  whitelist check now reads `SCREENER_SORT_FIELDS` instead of
  `SCREENER_FIELDS`, so a saved screen or live subscription can actually
  request it.
- `ScreenerTable.tsx` (`@terminal/ui`) — `SORTABLE_FIELDS` now built from
  `SCREENER_SORT_FIELDS`; clicking the `Symbol` column header sorts like
  any other sortable column (same click-to-toggle-asc/desc UX). `exchange`
  is still not sortable — it's categorical, no ordering defined for it,
  unchanged.

Verified: `@terminal/types` 42/42 (+1 new test, 2 assertions),
`@terminal/ui` 58/58, `tsc --noEmit` clean for `@terminal/types`/
`@terminal/ui`/`@terminal/web`/`@terminal/api-gateway`, `eslint` clean on
every touched package. Not yet browser-confirmed.

## Binance-preferred consolidation + coins/stocks quick filter (2026-07-19)

Request, verbatim: "let's do this: all coins are only displayed with
binance data. if there is no binance, then it is from another exchange
where it exists. also put a filter on stocks and coins." Driven by the
same session's earlier finding (see `docs/market-data-feeds.md`'s
2026-07-19 section) that the Screener's raw one-row-per-(exchange,symbol)
model, once the sharding/backpressure bugs were fixed and every venue was
actually flowing data, reads as noisy/duplicated to a user scanning for a
single price per coin — kucoin/bybit/okx all listing the same symbol looks
like clutter, not signal, for that use case.

**This is a display-layer transform only** — it does not touch the
underlying per-(exchange,symbol) data model (`docs/screener.md`'s
discovery use case, unchanged), does not change what a saved screen's
`ScreenDefinition` stores, and does not touch the gateway/WS wire protocol
at all. Both new functions live in `@terminal/types`
(`packages/types/src/screener.ts`), pure and fully unit-tested (48/48
green after `pnpm build && pnpm test`):

- `consolidateByVenuePreference(rows, priority = EXCHANGES)` — groups the
  subscription's raw rows by `symbol`. Binance (`priority[0]`) wins outright
  whenever it lists the symbol. **Revised 2026-07-19, same day** — the
  original version fell back to a fixed `EXCHANGES` priority order
  (`['binance','bybit','okx','hyperliquid','kucoin','aster','mexc','bingx']`)
  when Binance was absent; John reported this reads as "almost all coins are
  from kucoin" in practice and clarified the actual ask: "if there is no
  such coin on binance, then on another exchange, where the trading volume
  of this coin is higher (this is already new)." So the non-Binance
  fallback is now volume-based — whichever venue has the higher
  `volume_24h` for that specific symbol wins, not the next entry in a fixed
  array. `priority` order is now only a deterministic tie-break, used when
  volumes are equal or both `null` (e.g. a freshly-listed symbol with no
  derived stats yet) — this keeps the pick stable instead of flapping
  between venues tick to tick. A venue absent from `priority` still isn't
  excluded from the volume comparison, only from the tie-break. Preserves
  the input array's relative order (matters for the existing sort, which
  runs server-side before this transform ever sees the rows).
  **The cross-venue OI/funding fill was REMOVED 2026-07-26** — every value in a
  row now comes from that row's own exchange, full stop. Two reasons: it
  contradicted the venue-priority picker ("if mexc, then everything is on mexc"
  means the OI column must be MEXC's number), and it made the table
  self-inconsistent — the exchange quick-pick filters *server-side*, so
  selecting a venue removed the donor rows and open interest that had been
  visible under "All exchanges" vanished when the user picked that same
  exchange. The honest fix for a blank cell is to make the venue report the
  field (docs/market-data-feeds.md §P1.5e/§P1.5f), not to substitute another
  venue's number. The original rationale is kept below for context:

  ~~**Cross-venue OI/funding fill added 2026-07-23**~~ — only 5 of the 8 venues
  emit open interest (Binance/Bybit/OKX/HyperLiquid/Aster) and 6 emit funding;
  KuCoin/MEXC/BingX emit neither. Since the volume winner is often one of those
  three, a consolidated row would show a blank OI/funding cell even when another
  venue has the value for the same symbol (this was John's "open interest is not
  displayed" report). So when the winning row lacks `open_interest` or
  `funding_rate`, it now keeps its own price/volume/venue but borrows *only*
  those two fields from the best (same Binance-first / highest-volume rule)
  venue that has them. Deliberately narrow: price, %change, volume, and spread
  stay purely the winner's, so a row's core numbers never silently mix venues —
  only the two derivatives-only fields (broadly venue-consistent, fine for a
  screener glance, not for execution) are borrowed. If no venue has the field,
  it stays `null`.
- `isStockToken(symbol)` — a **client-side heuristic**, not a real
  `asset_class` field read: `ScreenerRow.asset_class` is hardcoded
  `"crypto"` for every row server-side today
  (`services/market-data/internal/store/state.go`) — real stock/crypto
  classification is unbuilt, owned by the still-unstarted roadmap item
  **P1B.3 "Stocks surface"** (`TASKS.md`). Matches Bybit's real TradFi
  tokenized-stock-perpetual naming convention, confirmed via WebSearch
  against Bybit's own announcements: `{TICKER}STOCKUSDT` (e.g.
  `AMDSTOCKUSDT`), i.e. `symbol.toLowerCase().endsWith('stockusdt')`. This
  only catches Bybit-listed tokenized stocks today — it is explicitly a
  stopgap, not the P1B.3 fix.

**Re-verified after the volume-tiebreak revision:** `@terminal/types` 51/51
(3 new cases: non-binance volume tiebreak wins over fixed priority order,
Binance still wins outright even when out-volumed, a known volume beats an
unknown/`null` one), `@terminal/api-gateway` and `@terminal/web`
`tsc --noEmit` clean, `@terminal/web` `node --test` 52/52. Not yet
browser-confirmed.

`ScreenerPanel.tsx` wires both together in one `displayRows` memo (filter
by `assetClassFilter` first, then `consolidateByVenuePreference` — cheaper
since asset-class filtering shrinks the set before dedup, and the two
operations are independent so order doesn't change the result either way).
`displayRows`, not the raw `rows` from `useScreenerSubscription`, now feeds
`ScreenerTable`, `handleExport`'s CSV builder, and the export button's
empty-state check. The existing per-exchange `exchangeFilter` quick-pick
(`docs/screener-ui.md`'s earlier P1.7 section) composes cleanly with this:
it's still applied server-side via the filter tree before rows ever reach
the client, so when it's set to a single exchange every row already shares
that exchange and `consolidateByVenuePreference` is a no-op per symbol —
no conflict between the two filters.

New UI: a second `<select>` next to the existing exchange-filter dropdown,
`''` (all) / `'coin'` / `'stock'`, new i18n keys
`screener.asset_class_filter.{label,all,coin,stock}` in both `en.ts` and
`ru.ts`.

Verified: `@terminal/types` 48/48, `@terminal/ui` 58/58, `@terminal/i18n`
16/16, `tsc --noEmit` clean for `@terminal/types`/`@terminal/ui`/
`@terminal/i18n`/`@terminal/api-gateway`/`@terminal/web`, `eslint src`
clean on `@terminal/web`. Not yet browser-confirmed — please open the
Screener, confirm duplicate symbols across venues collapse to a single
Binance-sourced row (falling back to another venue for symbols Binance
doesn't list), and confirm the new coins/stocks dropdown filters as
expected.

## Tests run in this sandbox

`@terminal/types`, `@terminal/ui`, `@terminal/i18n`, and `apps/web`'s own
`tsc`+`node --test` all pass (48 / 58 / 16 / 48 tests respectively,
0 fail), plus `eslint`/`prettier --check` clean across every touched file.
**Not exercised here** (no Docker/Postgres/Redis in this sandbox, same
standing limitation as every other P1.x task): the gateway's `/screener/query`
and `/screens` REST surface, the live WS `screener.subscribe` round trip
against a real `instrument_state` working set, and — as called out above —
whether the dev HTTPS proxy forwards the WS upgrade at all. Please run
`dev:up` / `dev:migrate` and open the terminal to confirm the screener
panel loads a preset, edits+applies a filter, sorts, exports a CSV, goes
`live` (not stuck on the connecting badge), and — new as of 2026-07-19 —
that Binance-preferred consolidation and the coins/stocks filter both
behave as expected, before treating this as confirmed.
