# Landing page (P1.2a)

Implemented in `apps/web` (Next.js App Router). Builds on P1.1/P1.2's auth +
gateway (`/docs/auth.md`, `/docs/gateway-ws.md`) — this doc covers the
marketing surface and the two non-obvious infra decisions it needed.

## Locale routing — no next-intl yet, on purpose

`packages/i18n/src/translate.ts` already says the plan explicitly: "the web
app will layer next-intl on top of the same catalogs (P1.3)." P1.2a is a
single page, so it doesn't need a routing framework yet — it uses the same
hand-rolled `t()`/catalog approach every other surface (gateway, bot) already
uses, wired into the App Router manually:

- `app/[locale]/layout.tsx` + `page.tsx` — `[locale]` is the **only**
  top-level route segment, so its `layout.tsx` doubles as the app's root
  layout (owns `<html lang={locale}>`). Only `en`/`ru` are valid; anything
  else 404s via `notFound()` rather than silently rendering as English (would
  create duplicate-content pages for search engines).
- `middleware.ts` redirects bare `/` to `/en` or `/ru` via
  `negotiateLocale(Accept-Language)` (already implemented + tested in
  `@terminal/i18n`, reused as-is).
- `generateMetadata` in the locale layout sets per-locale `<title>`,
  description, and `alternates.languages` for SEO.

When P1.3 brings in next-intl for the full terminal shell, this page's
`t()` calls can move onto it without changing the catalogs themselves — the
catalogs are already next-intl-shaped (flat keys, `{param}` interpolation,
CLDR plural objects).

## Same-origin gateway proxy — solves the Secure-cookie problem without weakening it

`docs/auth.md` flagged this at P1.1: the session cookie is `Secure`, which
won't round-trip over plain `http://localhost`, and api-gateway has no CORS
plugin (by design — architecture.md §2 says the browser only ever talks to
the gateway, so cross-origin was never supposed to be a requirement). Both
of those needed to stay true rather than get relaxed for dev convenience.

The fix uses two built-in Next.js features, no new infra:

1. **`next dev --experimental-https`** — Next's dev server generates (or
   uses `mkcert`, if installed and trusted) a local TLS cert, so the app
   itself is served at `https://localhost:3000`. A `Secure` cookie now has
   somewhere valid to round-trip to.
2. **`next.config.mjs` rewrites** — `/api/*` requests from the browser are
   proxied server-side (inside the Next.js process) to `GATEWAY_ORIGIN`
   (`http://localhost:8080` by default). From the browser's perspective,
   everything — page and API — is the same origin, so there's no CORS
   preflight to configure and the `Set-Cookie` response comes back as if it
   originated from `https://localhost:3000` itself.

`SignupForm.tsx` posts to `/api/auth/signup` (relative, never the gateway's
real origin directly) so this holds automatically.

**First run over HTTPS:** without `mkcert -install`, the browser will show a
self-signed-certificate warning on first visit — expected, click through.
Installing `mkcert` (`brew install mkcert && mkcert -install`) makes Next
use a locally-trusted cert instead and the warning goes away. Either way,
`GATEWAY_ORIGIN` and the `/api/*` rewrite work identically — nothing else to
configure.

Production topology (whether web and gateway share a domain there too, or
need real CORS) isn't decided yet — out of scope for this task, flag for a
future ADR when deployment is actually being planned.

**Known issue (2026-07-13): `--experimental-https` currently disabled in
`apps/web/package.json`'s `dev` script.** On John's machine, mkcert's
install step (it shells out to `sudo` to trust its local CA) hung with no
visible password prompt when run nested inside `pnpm` → `turbo` → `next
dev` — likely a lost TTY through that process chain. The `dev` script
temporarily drops the flag so `next dev` starts directly on plain
`http://localhost:3000`, which is enough to verify pages render but means
the `Secure` session cookie will not set from the signup form until this is
resolved. Follow-up: install mkcert directly in a plain terminal
(`brew install mkcert && mkcert -install`, outside the turbo/next process
tree) so the CA is already trusted before Next ever tries to invoke it, then
restore `--experimental-https` in the `dev` script.

## Environment note: the project folder must not contain `#`

Next.js encodes React Server Component module references internally as
`path#exportName`, and separately, `next build`'s `@vercel/nft` file tracer
does its own `readlink`/`realpath` resolution on the project path. Both
choked when this repo's folder was named `crypto_project #1` — the literal
`#` collided with the RSC module-reference delimiter (breaking `next dev`
rendering with "Could not find the module ... in the React Client
Manifest") and separately corrupted the tracer's paths into null bytes
(crashing `next build` outright). Neither is a Next.js config option away —
confirmed no `outputFileTracing` toggle exists in Next 15, and the RSC
manifest bug isn't a webpack `resolve.symlinks` issue either (a symlinked
workaround still resolved back through the real path).

**Fix:** rename the project folder to remove the space + `#` (e.g.
`crypto_project` or `crypto-project`) and reconnect it. This is a filesystem
naming constraint, not an application bug — once the path is clean, both
`next dev` and `next build` behave normally. After renaming, run
`pnpm install` again (node_modules symlinks can bake in absolute paths).

## Consuming `@terminal/ui`'s CSS from another package

`packages/ui`'s `tokens.css`/`terminal.css` live in `src/` (generated files,
committed) but the package had no way to import them from outside — no
`exports` map, and `dist/` only ever had compiled JS (`tsc` doesn't copy
`.css`). This is the first real external consumer of that CSS, so P1.2a
added: an `exports` map (`"./tokens.css"`, `"./terminal.css"` →
`dist/tokens.css`/`dist/terminal.css`) and a `cp` step in `@terminal/ui`'s
build script. `apps/web` imports both via plain package-subpath imports
(`import '@terminal/ui/tokens.css'`), which only resolve correctly **after**
`@terminal/ui` has been built at least once — Turbo's `dependsOn: ["^build"]`
on the `dev`/`build`/`typecheck` tasks handles that automatically when run
through `turbo`; running `next dev` directly (bypassing Turbo) requires
`pnpm --filter @terminal/ui build` first.

## Signup flow — what happens today vs. once the terminal exists

CLAUDE.md §1 describes "sign-up → straight into the terminal." The terminal
shell doesn't exist yet (P1.3+), so redirecting there today would 404.
`SignupForm.tsx` instead shows an inline success state on the same page.
Once P1.3 ships, swap that branch for a redirect to `/${locale}/terminal` —
noted inline in the component.

## Testing

No DOM/component-testing framework (jsdom, Testing Library, etc.) is set up
in this repo yet — every other package tests via plain `node:test` against
`tsc` output, and introducing a browser-testing stack is its own decision,
not something to fold silently into this task. What's testable without one:
the pure logic pulled out of the form (`src/lib/validateSignup.ts`,
`src/lib/authErrorMessage.ts`) has real `node:test` coverage, compiled
separately via `tsconfig.test.json` → `dist-test/` (Next's own build doesn't
emit plain-Node-runnable JS for arbitrary lib files the way `tsc` does, so
this mirrors the rest of the repo's test convention instead of relying on
Next's bundler). Catalog completeness (every `landing.*`/`error.*` key
existing in both `en`/`ru`) is already covered by `@terminal/i18n`'s
existing `ru catalog covers every en key` test — extending the catalogs is
automatically checked, nothing new needed there. Rendering/interaction
testing of the actual page is a gap, flagged rather than silently skipped.
