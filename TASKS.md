# TASKS.md — Build Tracker

Single source of truth for build progress. Works with `CLAUDE.md` (the contract) and `/docs` (feature specs).

## How to use this file

- **To resume after a limit reset:** read `CLAUDE.md`, open this file, find **Current position**, and start the first unchecked task.
- **Marking done:** only change `[ ]` → `[x]` when the task is _fully_ done. If you can't finish it, split it — never check a box for partial work.
- After each completed task, update **Current position** and commit this file together with the code.

**Definition of done (every task):** implemented · has tests wherever it touches money, market data, or secrets · passes lint/CI · committed.

**Model tags:**

- 🔷 **Fable** — top-tier capability. Use **only for Phase 0** ("the beginning") while your access lasts. If your Fable day runs out mid-phase, finish the rest of Phase 0 on Opus.
- 🟣 **Opus** — complex, algorithmic, or security-critical spikes.
- 🟢 **Sonnet** — default workhorse; limit-efficient, so **prefer it** for everything not tagged otherwise.

Tags are guidance, not law: if a "Sonnet" task turns out to be architecture-defining, escalate it; if an "Opus" task is routine, drop it to Sonnet.

**Current position:** ▶ **P1.3a** — Browser-style workspace tabs (P1.2b confirmed 2026-07-13: scroll-reveal, hero glow/cursor accent, hover micro-interactions, `prefers-reduced-motion` respected — visual-only task, no new automated tests, verified by John looking at it. His reaction: "I don't like it, but it'll do for now, then we'll coordinate the landing page" — accepted as MVP-sufficient, but landing-page visuals need his direct steer next time, not another unprompted pass; see feedback memory. Sonnet from here, Opus for tagged tasks. Phase-1 list amended at the 2026-07-12 review: +P1.0, +P1.2a landing, +P1.5a live feeds. **2026-07-12 feature intake (John):** amended P1.5a/P1.9/P2.2/P2.3; added P1.2b, P1.3a, P1.5b, P1.7b, P1.13a, P1.19; opened Phase 1B — admin panel, mobile+push, stocks/Snowball, IPOs)

---

## Phase 0 — Foundations (Day 1, Fable) 🔷

_The load-bearing decisions and skeletons everything else depends on. Front-loaded so they're done while Fable access lasts._

- [x] **F0.1** 🔷 Monorepo scaffold — `/apps`, `/services`, `/packages`, `/docs`; package manager + build orchestrator (pnpm + Turbo), lint/format, CI skeleton, `.env.example`.
- [x] **F0.2** 🔷 Architecture decision record → `/docs/architecture.md` — service boundaries, data-flow diagram, Redis topic/channel naming, error/reconnect conventions.
- [x] **F0.3** 🔷 Database schema (Postgres + TimescaleDB) → `/docs/schema.md` + migrations — candles, OI, funding, liquidation events, users, alerts, journal, strategies; hypertables + retention policies.
- [x] **F0.4** 🔷 Shared foundation in `/packages` — TS type definitions, RU/EN i18n scaffolding, number/date/timezone formatting utilities, user-timezone vs. fixed-NY-clock separation.
- [x] **F0.5** 🔷 Design system (Bloomberg) — load the `frontend-design` skill; define tokens (amber/green/red, mono numerics), base components, layout grid, **top status bar shell**, **command bar skeleton**. Keep §5 of `CLAUDE.md` as the reference.
- [x] **F0.6** 🔷 `market-data-service` (Go) skeleton — connection manager, normalization layer, reconnection + health-check framework, Redis publisher. No live feeds yet; just the resilient skeleton.
- [x] **F0.7** 🔷 Skills + repo setup — add the two marketplaces, run the security auditor, commit vetted skills to `.claude/skills/`, and create starter `SKILL.md` stubs for the crypto-domain skills (`coinglass-v4`, `hyperliquid-data`, `exchange-websockets`, `screener-engine`, `liquidation-heatmap`, `agent-runtime`, `i18n-ru-en`, `trading-security`).

_→ After F0.7, Fable's job is done. Everything below runs on Sonnet by default, Opus for the tagged hard parts._

---

## Phase 1 — MVP ("AI research terminal", no live money)

- [x] **P1.0** 🟢 Dev environment — `docker-compose` (Postgres+TimescaleDB, Redis), wired to `db/migrate.sh`, seed script, `.env` plumbing, README quick-start. _Added at Phase-0 review: nothing else provides local infra, and P1.1+ can't be tested without it._
- [x] **P1.1** 🟢 Auth + accounts (sign-up, login, sessions, OAuth).
- [ ] **P1.1a** 🟢 Discord OAuth — new sign-in provider alongside Google/Telegram, same `oauth_accounts` model from P1.1. Net-new integration (unlike P1.2c, there's no existing backend to surface — this is comparable in scope to the original Google/Telegram work). _Added 2026-07-13 (John), asked after seeing the terminal for the first time._
- [x] **P1.2** 🟢 `api-gateway` — REST + browser WebSocket gateway wired to Redis.
- [x] **P1.2a** 🟢 Landing page — bilingual (RU/EN) SSR marketing page with the registration form inline: sign-up → straight into the terminal (CLAUDE.md §1). SEO meta, design tokens from `@terminal/ui`. _Added at Phase-0 review: an MVP surface per CLAUDE.md §10 that had no task._
- [x] **P1.2b** 🟢 Landing page visual polish — smooth transitions/animations, on-scroll motion, refined hero; load the `senior-frontend` skill. _Added 2026-07-12 (John): P1.2a shipped functional-first by design; this is the dedicated design pass._
- [ ] **P1.2c** 🟢 Landing page social login buttons — surface Google + Telegram sign-in as buttons on the landing page's signup form (email+password is the only option shown today). Both providers' OAuth verification already ships in `api-gateway` from P1.1 (`oauth_accounts`, Google auth-code/id_token, Telegram Login Widget HMAC verify) — this is frontend wiring only, no new backend. _Added 2026-07-13 (John), asked after seeing the terminal for the first time._
- [x] **P1.3** 🟢 Terminal shell — left icon rail, dockable/resizable panels, saveable layouts, default view (screener + chart + news).
- [ ] **P1.3a** 🟢 Browser-style workspace tabs — multiple named tabs across the top of the terminal; switch/reorder/close, each tab carries its own saved layout, persisted per user. _Extends P1.3; the multi-tab shell every panel lives in._
- [ ] **P1.3b** 🟢 Tab drag-and-drop reordering — mouse drag-to-reorder in the tab strip. P1.3a shipped reordering via Alt+ArrowLeft/Right (keyboard-only, deliberate choice at the time); this adds the discoverable drag interaction on top, keyboard reorder stays as an a11y fallback. _Added 2026-07-13 (John), extends P1.3a._
- [ ] **P1.3c** 🟢 Panel drag-to-rearrange — let users drag a panel into a different column/position in the workspace grid, not just resize it. P1.3 deliberately scoped the grid as fixed columns of stacked panels (resizable, not movable) to avoid building a full synced-gutter N×M grid before it was needed; this revisits that call. _Added 2026-07-13 (John), extends P1.3._
- [ ] **P1.4** 🟢 Top status bar — NY time (auto EST/EDT), session strip (Sydney/Tokyo/London/NY) with active session + overlaps, importance indicator, live-news ticker, "next high-impact event" chip. _Ticker + event chip ship with placeholder sources; real data wires in at P1.9/P1.11. **Partially done early (2026-07-13):** the clock itself now ticks live client-side (`apps/web`'s `LiveStatusBar`) instead of the static server-render-time snapshot F0.5/P1.3 shipped — done as a quick fix while verifying P1.3a since CLAUDE.md §5 calls the live clock the "daily-retention hook." Session active/overlap highlighting updates live as a side effect of the same `now`. Ticker + event chip remain, still blocked on P1.9/P1.11 data — box stays unchecked until those land._
- [ ] **P1.5** 🟢 Command bar — fuzzy search over symbols + functions (`BTC HEAT`, `AAPL CHART`).
- [ ] **P1.5a** 🟢 Live exchange feeds — implement Binance/Bybit/OKX `conn.Feed`s (trades, candles, book, funding, OI) on the F0.6 framework; persist hypertables, maintain `instrument_state`, fan out `md.*`. Load the `exchange-websockets` skill. _Added at Phase-0 review: F0.6 built the skeleton feed-less by design; P1.6/P1.8/P1.12/P1.14 all consume live data. The remaining default venues (HyperLiquid, MEXC, BingX, KuCoin, Aster) land via the P1.5b adapter._
- [ ] **P1.5b** 🟣 Exchange adapter interface + full default venue set — a pluggable `Exchange` adapter contract (symbol mapping, WS/REST quirks, rate limits, health) so adding a venue is one adapter file; ship adapters for **Binance, Bybit, OKX, HyperLiquid, MEXC, BingX, KuCoin, Aster**. _Opus: the abstraction every downstream venue and the consolidated views (P1.7b, P2.2) depend on. Extends P1.5a._
- [ ] **P1.6** 🟣 Screener query engine — deterministic filter model (`field·operator·value`, AND/OR groups), volume sort, saved screens/presets, real-time updates. _Opus: correctness + throughput._
- [ ] **P1.7** 🟢 Screener UI — virtualized table, column config, filter builder front-end, export with watermark/referral link.
- [ ] **P1.7b** 🟢 Consolidated best price + available volume — across all connected venues, per symbol show the best bid/ask and the top-of-book size available at that price, live; scalpboard.io-style real-time scalping view. _Depends on P1.5b (multi-venue top-of-book). Deeper cross-venue spread/arb analysis is P2.2._
- [ ] **P1.8** 🟢 Charts — integrate charting lib; timeframe switching, indicator drawing hooks (for the agent later).
- [ ] **P1.9** 🟢 News pipeline — ingest CryptoPanic + CoinGecko + Telegram (MTProto) + Arkham + exchange listing/delisting announcements; normalize + dedupe. _Listing/delisting items feed the P1.13a alert type._
- [ ] **P1.10** 🟢 News LLM scoring — relevance/sentiment/asset tagging + "what does this mean for my positions?" (locale-aware).
- [ ] **P1.11** 🟢 Economic calendar — Trading Economics / FXStreet / Finnhub; events, importance tiers, forecasts, previous/actual; RU sources included.
- [ ] **P1.12** 🟣 Alert engine — deterministic rule evaluation against the live stream (price/indicator/liq-level/news). _Opus: the evaluation core._
- [ ] **P1.13** 🟢 Alert delivery — web + Telegram bot.
- [ ] **P1.13a** 🟢 Listing/delisting alerts — per-exchange listing & delisting notifications with fully user-customizable rules (which venues, new-listing vs delisting, quote-asset filters), delivered web + Telegram (+ mobile push once P1B.2 lands). _Consumes the P1.9 listing/delisting stream; built on the P1.12 engine._
- [ ] **P1.14** 🟢 Coinglass V4 integration — pull liquidation heatmap + OI/funding; render heatmap (ECharts). _Buy, don't build._
- [ ] **P1.15** 🟣 Backtesting engine — deterministic runner with fees/slippage/lookahead handling over historical data. _Opus._
- [ ] **P1.16** 🟣 NL → strategy spec — LLM turns plain-language ideas into a structured spec the engine in P1.15 runs; explain results back. _Opus._
- [ ] **P1.17** 🟢 Subscriptions + billing — tiers incl. managed-inference tier; BYO Anthropic key handling (encrypted, server-side).
- [ ] **P1.18** 🟢 Test pass + MVP hardening — coverage on P1.6/P1.12/P1.15/P1.17, error states, empty/loading states, RU/EN QA.
- [ ] **P1.19** 🟣 Active session management — list a user's active sessions (device, IP, GeoIP location, last-seen), revoke any one, and surface/allow logout of sessions active >24h. _Extends the P1.1 auth/session model; security-sensitive, gets tests before its box is checked._

---

## Phase 1B — Growth & platform surfaces

_Net-new surfaces John prioritized (2026-07-12) to run in parallel with late Phase 1 rather than wait for the endgame. Numbered P1B.x to avoid colliding with the P1.5/P1.5a scheme._

- [ ] **P1B.1** 🟣 Admin panel — registered-user count + growth, currently-online (live WS sessions), country breakdown (GeoIP), signup→activation funnel, per-user lookup/suspend, feature flags; role-gated + audit-logged. _Reads auth (P1.1) + gateway (P1.2) session data._
- [ ] **P1B.2** 🟣 Mobile apps (iOS + Android) + push — ship the terminal to phones (React Native/Expo or Tauri Mobile reusing the React app) with APNs/FCM push and a **critical-alert channel that wakes the user at night / bypasses Do Not Disturb** (iOS Critical Alerts entitlement, Android alarm/full-screen category). _Push wires into P1.13/P1.13a delivery; the entitlement approval has lead time — start early._
- [ ] **P1B.3** 🟢 Stocks surface (Snowball-style) — equities quotes, watchlists, fundamentals and a stock screener paralleling the crypto one; reuse the P1.6/P1.7 engine + UI where possible. _New market-data source; feeds P1B.4._
- [ ] **P1B.4** 🟢 IPO calendar + news — upcoming IPOs (date, venue, price range, status) plus related news, surfaced in the calendar + news pipelines. _Depends on P1B.3's stock data source; extends P1.9/P1.11._

---

## Phase 2 — Market-intelligence edge

- [ ] **P2.1** 🟣 Order-book aggregation — multi-exchange websockets, normalized L2 books, throughput-safe fan-out. _Opus._
- [ ] **P2.2** 🟣 Cross-exchange spreads / arbitrage / inefficiency detection — plus a clean, legible price-discrepancy visualization across venues (who's high/low, spread size and direction, at a glance). _Opus. The view consumes P1.5b venues + P1.7b best-price._
- [ ] **P2.3** 🟣 Real HyperLiquid liquidation map — pull on-chain positions, cluster wallets, separate whales vs. retail, plot real liq/stop levels; show side-by-side with the formula map. Let users import or manually add their own wallet addresses to track their own positions and liq levels on the map. _Opus — your differentiator._
- [ ] **P2.4** 🟢 Telegram mini-app — condensed alerts view (login → all alerts → manage), Telegram Web App SDK.
- [ ] **P2.5** 🟢 Trader's journal — auto-log from connected APIs + manual entries.
- [ ] **P2.6** 🟢 Journal LLM insights — patterns, mistakes, auto-tagging.
- [ ] **P2.7** 🟢 Viral export cards — shareable, watermarked, referral-linked.

---

## Phase 3 — Execution _(legal review gate first — human)_

- [ ] **P3.0** ⛔ Legal/compliance review — sign-off before any code touches exchange keys. _Human, not a model task._
- [ ] **P3.1** 🟣 Exchange API connection + encrypted key vault — secrets server-side / desktop-only, never in browser. _Opus — security-critical._
- [ ] **P3.2** 🟣 Execution guardrails — position limits, kill-switch, dry-run mode. _Opus._
- [ ] **P3.3** 🟢 Tauri desktop app — reuse the React app; move key handling + execution here.
- [ ] **P3.4** 🟢 Proxies — vetted pool or bring-your-own on desktop (pending legal).
- [ ] **P3.5** 🟢 Agent trading runtime — let a configured agent manage assets at user's own risk, behind the guardrails.

---

## Phase 4 — Network effects

- [ ] **P4.1** 🟢 Strategy marketplace — publish/browse; one-agent-one-strategy sharing.
- [ ] **P4.2** 🟣 Verified performance ratings — tamper-proof results from real trading; anti-cheat. _Opus — the hard endgame._
- [ ] **P4.3** 🟣 Copy-trading + leaderboards. _Opus._
- [ ] **P4.4** 🟢 Learn-by-watching — browser extension logs user actions → structured strategy profile fed back as context (not fine-tuning).

---

## Notes

- Anything touching keys, execution, or money gets tests **before** its box is checked.
- Validate quant output (P1.14/P1.15/P2.3) against a reference (e.g. Coinglass on the same symbol) before trusting it.
- If a task grows past ~a day of work, split it into sub-tasks here so progress stays markable.
