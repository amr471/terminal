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
column *and* every row, kept in sync in both dimensions — real machinery
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
the accessible fallback this task was scoped to add *alongside*, not
replace. Native HTML5 drag-and-drop (`draggable` + `onDragStart`/`onDragOver`/
`onDrop`/`onDragEnd`), no new dependency, same reasoning `ResizableColumns`
used for its own pointer math rather than pulling in a library.

`TabBar` (packages/ui) only tracks *which* tab is being dragged and *which
half* of the hovered tab the pointer is over (before/after, from the
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
  defined against the *post-removal* array so callers don't have to.

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
*existing* column/position** — dragging into empty space to create a
brand-new column isn't included; a future task if wanted.

The pure array surgery is `movePanel(definition, from, hover, insertAfter)`
in a new `packages/ui/src/panelOrder.ts`, same "pure math, own tests" split
`resize.ts` and P1.3b's `tabOrder.ts` both use. Panels have one wrinkle tabs
didn't: dragging the *last* panel out of a column would leave behind an
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
  *after* that block, never inside it. `fetch()` throws on a connection
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

## Known gaps, deliberately out of scope for P1.3

- **Icon rail links all point at `/terminal`.** Real per-section routes
  arrive with each feature (P1.6 screener, P1.8 charts, P1.9–10 news, ...);
  nothing to link to yet, so nothing is marked "active" either.
- **Command bar is parse-only.** `onCommand` discards the parsed command —
  P1.5 gives it a destination.
- **HTTPS is still disabled locally** (`docs/landing-page.md`'s "Known
  issue" section, unresolved from P1.2a) — the `Secure` session cookie
  won't set over the plain-http dev server, so the auth-gated redirect and
  the layout autosave can't be exercised end to end on John's machine until
  mkcert is installed outside the turbo/next process tree and
  `--experimental-https` is restored.
