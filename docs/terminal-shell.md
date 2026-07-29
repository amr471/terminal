# Terminal shell (P1.3, tabs added at P1.3a)

The dockable multi-panel workspace behind the session-gated `/[locale]/terminal`
route: top status bar, left icon rail, command bar, a browser-style tab strip
(P1.3a), and a resizable panel grid — each tab carrying its own saved layout.
Placeholder Screener/Chart/News panels — the real features land at P1.6–P1.10;
this proves the shell mechanics ahead of the data, same pattern F0.6 used for
market-data (skeleton before feeds).

## Layout model — columns of stacked panels, not a general N×M grid

`@terminal/types`' `LayoutDefinition` (`packages/types/src/layout.ts`)
deliberately models the workspace as columns side by side, each column an
independent vertical stack of panels — not a fully general drag-and-drop
grid where any panel can dock anywhere. CLAUDE.md §5 asks for "resizable,
saveable layouts," not arbitrary rearrangement, and the simpler model covers
that without needing synchronized gutter tracks in two dimensions (see the
next section). Multi-column-with-stacks is expressive enough for the
specified default view (screener | chart / news stacked) and any layout in
that shape; free-form panel rearranging is a real future feature, not
built here.

```ts
interface LayoutDefinition {
  version: 1;
  columns: { size: number; panels: { kind: 'screener' | 'chart' | 'news'; size: number }[] }[];
}
```

Every `size` is in fr units (CSS grid fractional units); resizing
redistributes fr between two adjacent tracks, never touches pixels outside
the browser. `validateLayoutDefinition` (same shape as screener.ts's
`validateFilterNode`) enforces `MAX_LAYOUT_COLUMNS`/`MAX_PANELS_PER_COLUMN`
and a `MIN_TRACK_SIZE_FR` floor — defense against hostile or malformed
definitions, same reasoning as the screener filter tree's node budget.

## Resize implementation — flexbox, not WorkspaceGrid's CSS grid

`WorkspaceGrid` (F0.5) is a CSS-grid shell using `grid-template-areas`.
Making that resizable would need gutter tracks inserted between every
column _and_ every row, kept in sync in both dimensions — real machinery
for the same visual result two nested flex axes give directly: columns are
flex items in a row, each column's panels are flex items in its own nested
column. `ResizableColumns` (`packages/ui/src/components/ResizableColumns.tsx`)
implements that; `WorkspaceGrid` stays available for any future layout
that's genuinely static.

All the actual math is pure functions in `packages/ui/src/resize.ts`
(`resizeTracks`, `pixelDeltaToFr`) — the component only turns pointer/
keyboard events into calls to them. `resizeTracks` takes from one track and
gives to its neighbor so the total is unchanged, and rejects outright
(rather than partially clamping) once either side would cross
`MIN_TRACK_SIZE_FR` — avoids a resize "sticking" at the floor while the
pointer keeps moving. Every drag handle is `role="separator"` with a
keyboard fallback (arrow keys nudge by a fixed fr step) per the
accessibility checklist.

## `/layouts/tabs` — browser-style workspace tabs (P1.3a)

P1.3 shipped `/layouts/default`: exactly one saved layout per user, no
management UI. P1.3a generalizes that to N named, orderable, closable tabs —
every row in `layouts` (migration 0004) is now one tab, carrying its own
`LayoutDefinition`. The old `is_default` boolean and its partial unique index
become `is_active` / `layouts_one_active_per_user`; the old `name` column
(internal, unique per user) stays as a server-generated id, and a new `title`
column is the renameable label the user sees. `sort_order` positions the tab
in the strip.

`services/api-gateway/src/layoutRoutes.ts` exposes:

- `GET /layouts/tabs` → `{ tabs: TerminalTabSummary[] }`, ordered by
  `sort_order`. Lazily provisions one tab titled `'Main'` for a user with
  zero tabs (brand-new signup, or — defensively — a user whose tabs were
  somehow all deleted), so the shell always has something to render. The
  title matches migration 0004's backfill value for pre-existing P1.3
  single-layout users, so old and new accounts converge on the same label.
- `POST /layouts/tabs` → `{ title, definition? }`, creates and activates a
  new tab (opening a tab switches to it), deactivating whichever tab was
  active. Rejected past `MAX_TABS_PER_USER` (GW-2013) — a budget guard, same
  reasoning as `MAX_LAYOUT_COLUMNS`.
- `PUT /layouts/tabs/:id` → partial update, `{ title? , definition? }`
  (GW-2008 if neither is present; GW-2012 if the tab isn't found/owned).
- `PUT /layouts/tabs/:id/activate` → switches which tab is active.
- `PUT /layouts/tabs/reorder` → `{ order: string[] }`; rejected (GW-2008,
  no partial write) unless `order` is exactly the user's current tab-id set
  with no duplicates — a mismatched list is hostile input, same
  reject-rather-than-partial-clamp stance `resize.ts` takes on the panel
  grid itself.
- `DELETE /layouts/tabs/:id` → refuses to delete a user's last tab
  (GW-2011: the shell always needs at least one). If the deleted tab was
  active, activates the remaining tab with the smallest `sort_order` and
  returns its id as `activeTabId` so the client knows where to land.

Every multi-row mutation (create/activate/reorder/delete all touch
`is_active` and/or `sort_order` across more than one row) runs inside a
transaction in `services/api-gateway/src/layouts.ts`, same
`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` pattern `users.ts`'s
`linkOrCreateOAuthUser` already uses.

On the frontend, `apps/web/src/components/TerminalTabs.tsx` owns the tab
list/active-tab state and every mutation above (all fire-and-forget/
best-effort against the network, same stance as `TerminalWorkspace`'s
autosave — a dropped request just means the next page load falls back to
whatever the server last saved). `@terminal/ui`'s `TabBar` is presentational:
click to activate, double-click to rename inline, a "+" button to open a new
tab, and — since the standard WAI-ARIA tabs pattern already claims plain
ArrowLeft/ArrowRight for moving focus between tabs — reordering is
`Alt+ArrowLeft`/`Alt+ArrowRight` on a focused tab (advertised via
`aria-keyshortcuts`). P1.3a shipped that keyboard-only, deliberately —
`TerminalWorkspace` gained a required `tabId` prop (the autosave target,
`PUT /layouts/tabs/:tabId`) and is remounted via `key={activeTab.id}` on
every tab switch, since its `initialDefinition` prop is deliberately only
read once on mount.

### Mouse drag-and-drop reordering (P1.3b)

Layered on top of P1.3a's Alt+ArrowLeft/Right, which stays exactly as-is —
the accessible fallback this task was scoped to add _alongside_, not
replace. Native HTML5 drag-and-drop (`draggable` + `onDragStart`/`onDragOver`/
`onDrop`/`onDragEnd`), no new dependency, same reasoning `ResizableColumns`
used for its own pointer math rather than pulling in a library.

`TabBar` (packages/ui) only tracks _which_ tab is being dragged and _which
half_ of the hovered tab the pointer is over (before/after, from the
pointer's x-position against the hovered tab's bounding-rect midpoint) — it
does not compute the resulting order itself. That stays in `apps/web`'s
`tabOrder.ts`, same split `onReorder`'s existing `swapAdjacent` already
uses, and for the same reason: `packages/ui` must not depend on `apps/web`.
Two new pure functions there:

- `dropTargetIndex(items, dragId, hoverId, insertAfter)` — converts the drag
  gesture into the index the moved tab should end up at, accounting for the
  list shrinking by one once the dragged item is removed (the usual
  off-by-one trap in any drag-reorder implementation).
- `reorderTo(items, id, targetIndex)` — moves one item to an arbitrary
  index, unlike `swapAdjacent`'s single-step neighbor swap; `targetIndex` is
  defined against the _post-removal_ array so callers don't have to.

`TerminalTabs.tsx`'s `handleDropReorder` chains the two exactly like
`handleReorder` chains `swapAdjacent` — compute, optimistically apply,
best-effort `PUT /layouts/tabs/reorder` with the full new order (the same
endpoint P1.3a's keyboard reorder already uses; no backend changes needed
for P1.3b at all). A thin amber `box-shadow` on the hovered tab's near edge
is the only new visual (`.t-tabbar__tab--drop-before`/`--drop-after` in
`terminal.css`), plus a dimmed (`opacity: 0.4`) dragged tab
(`--dragging`) — kept deliberately minimal per CLAUDE.md §5's "refined, not
cluttered."

Touch/mobile drag is out of scope — native HTML5 drag-and-drop doesn't fire
on touch at all, and this is a desktop-first terminal (same class of
scope call as P1.3's fixed-column layout grid).

### Panel drag-and-drop repositioning (P1.3c)

Revisits the "columns of stacked panels, not a general N×M grid" scope call
this file opens with — but only the "not movable, only resizable" half of
it. Moving a panel is still expressed entirely in the existing
`LayoutDefinition` shape (no schema change): remove it from its source
column's `panels` array, insert it into the destination column's `panels`
array at the drop position. **Deliberately scoped to moving a panel into an
_existing_ column/position** — dragging into empty space to create a
brand-new column isn't included; a future task if wanted.

The pure array surgery is `movePanel(definition, from, hover, insertAfter)`
in a new `packages/ui/src/panelOrder.ts`, same "pure math, own tests" split
`resize.ts` and P1.3b's `tabOrder.ts` both use. Panels have one wrinkle tabs
didn't: dragging the _last_ panel out of a column would leave behind an
empty column, which `validateLayoutDefinition` (packages/types) rejects as
invalid — so `movePanel` removes that column entirely instead, and the
remaining columns' space redistributes for free via flex (no rebalancing
math needed). A move that would push the destination column over
`MAX_PANELS_PER_COLUMN` is rejected outright, same
reject-rather-than-partial-clamp stance `resizeTracks` already takes at the
size floor.

Unlike `TabBar` (a controlled, "dumb" component — `TerminalTabs.tsx` in
apps/web owns the tab array and all its mutations), `ResizableColumns`
already owns its own `definition` state and already has an `onChange`
autosave escape hatch, exactly like its resize handles do — so
`movePanel` is called directly inside `ResizableColumns`, no
`packages/ui`-must-not-import-`apps/web` split needed here the way P1.3b's
`onDropReorder` callback required for tabs.

Dragging is initiated from the panel's **header only** (`Panel`'s new
`headerProps` passthrough — `draggable`, the drag event handlers, and the
Alt+Arrow keyboard handler all attach there), not the whole panel, so a
future panel with real interactive content (table rows, text) doesn't fight
the browser's native drag gesture over its data body. The drop target
detection (which panel, top half vs bottom half) still covers the panel's
full bounding box, via `onDragOver`/`onDrop` on the outer panel wrapper —
mirrors how real dockable UIs use the title bar as the grip but accept a
drop anywhere over the target pane.

**Keyboard fallback**, consistent with `TabBar`'s Alt+ArrowLeft/Right and
the resize handles' plain arrow keys: a focused panel header takes
Alt+ArrowUp/Down to swap with the adjacent panel in its own column, and
Alt+ArrowLeft/Right to move to the end of the adjacent column (simplest
predictable behavior — it doesn't try to preserve "the same vertical slot"
across columns of different lengths, which gets fiddly for little benefit).

## Secondary user-timezone clock (P1.4a)

A second, user-picked clock next to the fixed NY session clock in
`StatusBar` — the NY clock stays exactly as it was, still the fixed
session-overlap anchor (CLAUDE.md §5/§8's fixed-clock-vs-user-timezone
split, restated in `packages/i18n/src/sessions.ts`'s own doc comment: "the
user's timezone plays no role here").

**Display** reuses existing infrastructure rather than adding new formatting
logic: `formatTime(tsMs, locale, tz)` (`packages/i18n/src/time.ts`) already
supported an arbitrary IANA zone, just wasn't wired to any UI yet. The one
new piece is `isValidTimezone(tz)`, a guard (`Intl.DateTimeFormat` throws
`RangeError` on a bad zone) used before trusting a value read back out of
storage.

**Component split**, same shape as the P1.3 status-bar/live-wrapper
boundary: `StatusBar` (packages/ui) gains an optional `secondaryClock?:
ReactNode` slot — same escape-hatch pattern its existing `ticker` prop
already uses, so it stays agnostic and its own session/overlap tests are
untouched. The actual `SecondaryClock` component (packages/ui) is
presentational: a button showing "+ Add clock" when nothing's picked, or
the ticking time + city name once one is; clicking opens a small popover
with a native `<select>` (not a custom searchable combobox — with ~400 IANA
zones, the browser's own type-ahead select is already accessible for free).
The zone list comes from `Intl.supportedValuesOf('timeZone')` at module
load, with a small hardcoded fallback for runtimes lacking that API.

`SecondaryClock` owns its own popover open/closed state locally (pure UI,
nothing else needs it) but does _not_ own the selected timezone or its
persistence — that's lifted to `apps/web/src/components/LiveStatusBar.tsx`
(already the one stateful piece in this family, ticking the clock every
second) via `tz`/`onSelectTz`/`onClear` props, and read/written to
`localStorage` under `terminal.secondaryTz`. The stored value is read
lazily in a `useEffect` (not a `useState` initializer) so the very first
client render matches the server-rendered markup before `localStorage` is
consulted — the same hydration-safety shape `initialNowIso` already uses to
seed the clock itself.

**Scope call — browser-local, not account-synced.** The chosen timezone
persists per-browser via `localStorage`, not to the user's account, so it
won't follow them to a different device or browser. This matches the
task's "click to open a picker" framing without a new backend
endpoint/migration/table column for a single client preference. Syncing it
to the account is a natural, self-contained follow-up if wanted — likely a
`users.secondary_timezone` column plus a small `PATCH` endpoint, same shape
as any other user preference, whenever one exists.

**Bug fix (found 2026-07-13, after P1.5 shipped):** John reported the
timezone picker popover was invisible/unclickable, covered by the command
bar. Two fixes were needed — the first alone did not resolve it.

_First attempt (insufficient):_ `.t-secondary-clock__popover` was set to the
same z-index tier as the command bar itself (`--t-layer-command-bar`, 200)
rather than the dedicated overlay tier (`--t-layer-overlay`, 300) — a
pre-existing P1.4a mistake. Bumping the popover to `--t-layer-overlay`
seemed right but did not fix the bug in practice.

_Real root cause:_ `.t-statusbar` itself declared
`z-index: var(--t-layer-status-bar)` (100). `.t-statusbar` is a flex item of
`.terminal-shell`, and a flex item with a non-`auto` z-index establishes its
own stacking context — this caps *every descendant*, including the
popover, at that context's level (100) when compared against a sibling
context such as `.t-commandbar` (200). A descendant's own z-index (even
`--t-layer-overlay`, 300) only wins comparisons *within* its parent's
stacking context; it can never escape that context to outrank a sibling.
That's why the first fix had no visible effect — the popover's 300 was
only ever competing against other elements inside `.t-statusbar`'s own
context, never against the command bar.

Fixed by removing `z-index: var(--t-layer-status-bar)` from `.t-statusbar`
entirely (confirmed via grep that this token wasn't relied on elsewhere).
Without a forced stacking context on the status bar, the popover's own
`--t-layer-overlay` z-index now compares directly against `.t-commandbar`'s
200 at the shared top-level context, and wins as intended.

## Session gating — Server Component, not middleware

`apps/web/src/app/[locale]/terminal/page.tsx` is a Server Component that
forwards the browser's raw `Cookie` header to `GET {GATEWAY_ORIGIN}/auth/me`
and redirects to `/${locale}` on anything other than a 200. Two things worth
noting for future terminal pages:

- Both gateway fetches use `cache: 'no-store'`. This is per-user data keyed
  by the forwarded cookie — Next's default fetch caching in Server
  Components would otherwise risk serving one user's session/layout to the
  next request for the same URL.
- The `/auth/me` fetch is wrapped in try/catch, and `redirect()` is called
  _after_ that block, never inside it. `fetch()` throws on a connection
  failure (not just a non-2xx response), and Next's `redirect()` works by
  throwing its own control-flow signal — catching too broadly around it
  would swallow that signal. An unreachable gateway degrades to "not
  authenticated" rather than crashing the page.

Route-segment gating in `middleware.ts` (rather than per-page) was
considered and rejected for now: middleware would still need this same
`/auth/me` fetch, on top of whichever page-level fetch is needed for actual
data — same auth check either way, with less code doing it in the page
that already needs the session-verified response.

`SignupForm.tsx` now redirects to `/${locale}/terminal` on success (its own
code comment had flagged this as the P1.3 follow-up) instead of showing an
inline message — the browser already has the `Set-Cookie` from the signup
response by the time the redirect fires.

## Placeholder news ticker + "next event" chip (P1.4)

`StatusBar`'s `ticker`/`nextEventHours` slots (existing since F0.5) are now
populated — but with mock data, per TASKS.md's own P1.4 note that these ship
with placeholder sources first. `apps/web/src/lib/placeholderFeed.ts` holds a
small bilingual (en/ru) array of illustrative headlines and a handful of
daily-recurring mock calendar events (`nextPlaceholderEvent(now)` is the pure,
unit-tested "which one's soonest" math). `LiveStatusBar` rotates the ticker
headline every 8s and recomputes the event chip once a minute — both
deliberately omitted from `LiveStatusBarProps` (unlike `StatusBar` itself,
which still accepts them directly) since this wrapper always computes them,
never takes them from a caller.

Real data replaces this at P1.9 (news pipeline) and P1.11 (economic
calendar): `placeholderFeed.ts` is meant to be **deleted**, not extended,
once that lands — `LiveStatusBar` should swap in a real feed hook in its
place rather than growing the rotation logic further.

## Fuzzy command palette + destination wiring (P1.5)

`CommandBar` (packages/ui) grew a live suggestion palette on top of its
existing deterministic `parseCommand` grammar: `fuzzyCommand.ts`'s
`suggestionsFor(input, symbols)` tokenizes the same way `parseCommand`
ultimately will, fuzzy-matching (`fuzzyScore` — simple subsequence scoring,
prefix matches win) against the fixed function-code list and a
caller-supplied symbol list. Arrow keys move the highlighted suggestion,
Enter commits it (or falls back to the raw typed text if the palette's been
dismissed with Escape), mouse click/hover work the same way. `CommandBar`
stays domain-agnostic about _which_ symbols exist — it takes an optional
`symbols` prop rather than importing any placeholder data itself, the same
boundary `TabBar`/`ResizableColumns` already draw against apps/web-owned
state.

`apps/web/src/lib/placeholderSymbols.ts` supplies that list today: four
tickers mirroring `db/dev/seed.sql`'s dev-seed `instrument_state` rows
(BTC/ETH/SOL/AAPL). No real instrument directory is reachable from the
frontend yet (P1.6's screener query engine / P1.5a's live feeds) — same
placeholder-now-delete-later stance as P1.4's `placeholderFeed.ts`.

**Destination**, scoped to what's actually built: `TerminalCommandBar`
(apps/web) maps `CHART`/`NEWS`/`SCREEN` to the three real
`TerminalPanelKind`s `ResizableColumns` can render, and does a plain
`document.querySelector('[data-panel-kind="..."]')` (a new attribute
`ResizableColumns` sets on each panel wrapper) to scroll to and briefly
highlight a matching panel _if the active tab's layout has one_. This is a
deliberately decoupled DOM query rather than threading React state across
from `TerminalTabs` — `CommandBar` and the tab strip are unrelated siblings
under the server `page.tsx`, and "find the element and scroll to it" isn't
something that needs to be reactive the way autosave state is. If a layout
has more than one panel of the same kind, only the first match in DOM order
gets focused — an acceptable limitation for a single-panel-per-kind default
layout, revisit if that changes.

`HEAT`/`CAL`/`JRNL`/`AL` (no feature built yet) and any command carrying a
symbol (no per-instrument view exists before P1.6+) surface a plain
"not built yet" message (`terminal.command_not_available`, auto-clears
after a few seconds) instead of the previous silent no-op.

## Known gaps, deliberately out of scope for P1.3

- **Icon rail links all point at `/terminal`.** Real per-section routes
  arrive with each feature (P1.6 screener, P1.8 charts, P1.9–10 news, ...);
  nothing to link to yet, so nothing is marked "active" either.
- **HTTPS is still disabled locally** (`docs/landing-page.md`'s "Known
  issue" section, unresolved from P1.2a) — the `Secure` session cookie
  won't set over the plain-http dev server, so the auth-gated redirect and
  the layout autosave can't be exercised end to end on John's machine until
  mkcert is installed outside the turbo/next process tree and
  `--experimental-https` is restored.

## Session strip: 24/7 bands + a separate weekend marker (2026-07-26)

`isSessionOpen` no longer considers the weekday. The strip originally followed
FX dealing-desk convention (Mon–Fri), so every label went dim Sat/Sun — John
reported "the session is not displayed" four times before we settled it, most
recently seeing a dim NEW YORK at Sunday 12:57 EDT. His call: this is a
crypto-first terminal, crypto trades through the weekend, and its liquidity
still follows these regional hour bands, so a strip that's dead two days a week
is dead weight exactly when he's looking at it.

So there are now two independent signals:

- **The bands highlight 24/7**, purely on hour-of-day in each hub's timezone.
- **`isMarketWeekend()`** drives a separate badge — "Weekend — equities & FX
  closed" — so a lit NEW YORK band on a Sunday isn't misread as an open
  equities session.

`isMarketWeekend` uses the industry-standard FX weekend window expressed in New
York time: **Friday 17:00 NY → Sunday 17:00 NY** (Sydney's Monday open). A
naive "is it Sat/Sun" check gets this wrong in both directions because the hubs
straddle the dateline — at Sunday 12:57 NY it is already Monday in Sydney, yet
the market is still shut. (An earlier attempt that required *every* hub to be
on a weekend failed exactly this case; the test suite pins both boundaries.)
The `status.session.all_closed` string now means only a genuine between-bands
gap.
