# Terminal shell (P1.3)

The dockable multi-panel workspace behind the session-gated `/[locale]/terminal`
route: top status bar, left icon rail, command bar, and a resizable panel
grid with a saved default layout. Placeholder Screener/Chart/News panels —
the real features land at P1.6–P1.10; this proves the shell mechanics ahead
of the data, same pattern F0.6 used for market-data (skeleton before feeds).

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

## `/layouts/default` — one layout per user, not layout management

`services/api-gateway/src/layoutRoutes.ts` exposes exactly two endpoints:

- `GET /layouts/default` → `{ definition: LayoutDefinition | null }`
- `PUT /layouts/default` → validates the body against
  `validateLayoutDefinition` (GW-2010 if invalid, GW-2008 if the body shape
  itself is wrong), upserts, always `is_default = true`.

Both session-authenticated via `requireSession` (same as every other REST
route). The `layouts` table (migration 0002) supports named, non-default
layouts and switching between them, but P1.3 only ever writes one row named
`'default'` per user — the terminal shell needs "the user's current
workspace," not a layout-management UI. Named layouts + switching is a real
future feature, not needed yet.

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
