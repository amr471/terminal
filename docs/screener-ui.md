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

## Tests run in this sandbox

`@terminal/types`, `@terminal/ui`, `@terminal/i18n`, and `apps/web`'s own
`tsc`+`node --test` all pass (26 / 58 / 16 / 48 tests respectively,
0 fail), plus `eslint`/`prettier --check` clean across every touched file.
**Not exercised here** (no Docker/Postgres/Redis in this sandbox, same
standing limitation as every other P1.x task): the gateway's `/screener/query`
and `/screens` REST surface, the live WS `screener.subscribe` round trip
against a real `instrument_state` working set, and — as called out above —
whether the dev HTTPS proxy forwards the WS upgrade at all. Please run
`dev:up` / `dev:migrate` and open the terminal to confirm the screener
panel loads a preset, edits+applies a filter, sorts, exports a CSV, and
goes `live` (not stuck on the connecting badge) before treating this as
confirmed.
