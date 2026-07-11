# TASKS.md — Build Tracker

Single source of truth for build progress. Works with `CLAUDE.md` (the contract) and `/docs` (feature specs).

## How to use this file
- **To resume after a limit reset:** read `CLAUDE.md`, open this file, find **Current position**, and start the first unchecked task.
- **Marking done:** only change `[ ]` → `[x]` when the task is *fully* done. If you can't finish it, split it — never check a box for partial work.
- After each completed task, update **Current position** and commit this file together with the code.

**Definition of done (every task):** implemented · has tests wherever it touches money, market data, or secrets · passes lint/CI · committed.

**Model tags:**
- 🔷 **Fable** — top-tier capability. Use **only for Phase 0** ("the beginning") while your access lasts. If your Fable day runs out mid-phase, finish the rest of Phase 0 on Opus.
- 🟣 **Opus** — complex, algorithmic, or security-critical spikes.
- 🟢 **Sonnet** — default workhorse; limit-efficient, so **prefer it** for everything not tagged otherwise.

Tags are guidance, not law: if a "Sonnet" task turns out to be architecture-defining, escalate it; if an "Opus" task is routine, drop it to Sonnet.

**Current position:** ▶ **F0.6** — `market-data-service` (Go) skeleton

---

## Phase 0 — Foundations (Day 1, Fable) 🔷
*The load-bearing decisions and skeletons everything else depends on. Front-loaded so they're done while Fable access lasts.*

- [x] **F0.1** 🔷 Monorepo scaffold — `/apps`, `/services`, `/packages`, `/docs`; package manager + build orchestrator (pnpm + Turbo), lint/format, CI skeleton, `.env.example`.
- [x] **F0.2** 🔷 Architecture decision record → `/docs/architecture.md` — service boundaries, data-flow diagram, Redis topic/channel naming, error/reconnect conventions.
- [x] **F0.3** 🔷 Database schema (Postgres + TimescaleDB) → `/docs/schema.md` + migrations — candles, OI, funding, liquidation events, users, alerts, journal, strategies; hypertables + retention policies.
- [x] **F0.4** 🔷 Shared foundation in `/packages` — TS type definitions, RU/EN i18n scaffolding, number/date/timezone formatting utilities, user-timezone vs. fixed-NY-clock separation.
- [x] **F0.5** 🔷 Design system (Bloomberg) — load the `frontend-design` skill; define tokens (amber/green/red, mono numerics), base components, layout grid, **top status bar shell**, **command bar skeleton**. Keep §5 of `CLAUDE.md` as the reference.
- [ ] **F0.6** 🔷 `market-data-service` (Go) skeleton — connection manager, normalization layer, reconnection + health-check framework, Redis publisher. No live feeds yet; just the resilient skeleton.
- [ ] **F0.7** 🔷 Skills + repo setup — add the two marketplaces, run the security auditor, commit vetted skills to `.claude/skills/`, and create starter `SKILL.md` stubs for the crypto-domain skills (`coinglass-v4`, `hyperliquid-data`, `exchange-websockets`, `screener-engine`, `liquidation-heatmap`, `agent-runtime`, `i18n-ru-en`, `trading-security`).

*→ After F0.7, Fable's job is done. Everything below runs on Sonnet by default, Opus for the tagged hard parts.*

---

## Phase 1 — MVP ("AI research terminal", no live money)

- [ ] **P1.1** 🟢 Auth + accounts (sign-up, login, sessions, OAuth).
- [ ] **P1.2** 🟢 `api-gateway` — REST + browser WebSocket gateway wired to Redis.
- [ ] **P1.3** 🟢 Terminal shell — left icon rail, dockable/resizable panels, saveable layouts, default view (screener + chart + news).
- [ ] **P1.4** 🟢 Top status bar — NY time (auto EST/EDT), session strip (Sydney/Tokyo/London/NY) with active session + overlaps, importance indicator, live-news ticker, "next high-impact event" chip.
- [ ] **P1.5** 🟢 Command bar — fuzzy search over symbols + functions (`BTC HEAT`, `AAPL CHART`).
- [ ] **P1.6** 🟣 Screener query engine — deterministic filter model (`field·operator·value`, AND/OR groups), volume sort, saved screens/presets, real-time updates. *Opus: correctness + throughput.*
- [ ] **P1.7** 🟢 Screener UI — virtualized table, column config, filter builder front-end, export with watermark/referral link.
- [ ] **P1.8** 🟢 Charts — integrate charting lib; timeframe switching, indicator drawing hooks (for the agent later).
- [ ] **P1.9** 🟢 News pipeline — ingest CryptoPanic + CoinGecko + Telegram (MTProto) + Arkham; normalize + dedupe.
- [ ] **P1.10** 🟢 News LLM scoring — relevance/sentiment/asset tagging + "what does this mean for my positions?" (locale-aware).
- [ ] **P1.11** 🟢 Economic calendar — Trading Economics / FXStreet / Finnhub; events, importance tiers, forecasts, previous/actual; RU sources included.
- [ ] **P1.12** 🟣 Alert engine — deterministic rule evaluation against the live stream (price/indicator/liq-level/news). *Opus: the evaluation core.*
- [ ] **P1.13** 🟢 Alert delivery — web + Telegram bot.
- [ ] **P1.14** 🟢 Coinglass V4 integration — pull liquidation heatmap + OI/funding; render heatmap (ECharts). *Buy, don't build.*
- [ ] **P1.15** 🟣 Backtesting engine — deterministic runner with fees/slippage/lookahead handling over historical data. *Opus.*
- [ ] **P1.16** 🟣 NL → strategy spec — LLM turns plain-language ideas into a structured spec the engine in P1.15 runs; explain results back. *Opus.*
- [ ] **P1.17** 🟢 Subscriptions + billing — tiers incl. managed-inference tier; BYO Anthropic key handling (encrypted, server-side).
- [ ] **P1.18** 🟢 Test pass + MVP hardening — coverage on P1.6/P1.12/P1.15/P1.17, error states, empty/loading states, RU/EN QA.

---

## Phase 2 — Market-intelligence edge

- [ ] **P2.1** 🟣 Order-book aggregation — multi-exchange websockets, normalized L2 books, throughput-safe fan-out. *Opus.*
- [ ] **P2.2** 🟣 Cross-exchange spreads / arbitrage / inefficiency detection. *Opus.*
- [ ] **P2.3** 🟣 Real HyperLiquid liquidation map — pull on-chain positions, cluster wallets, separate whales vs. retail, plot real liq/stop levels; show side-by-side with the formula map. *Opus — your differentiator.*
- [ ] **P2.4** 🟢 Telegram mini-app — condensed alerts view (login → all alerts → manage), Telegram Web App SDK.
- [ ] **P2.5** 🟢 Trader's journal — auto-log from connected APIs + manual entries.
- [ ] **P2.6** 🟢 Journal LLM insights — patterns, mistakes, auto-tagging.
- [ ] **P2.7** 🟢 Viral export cards — shareable, watermarked, referral-linked.

---

## Phase 3 — Execution *(legal review gate first — human)*

- [ ] **P3.0** ⛔ Legal/compliance review — sign-off before any code touches exchange keys. *Human, not a model task.*
- [ ] **P3.1** 🟣 Exchange API connection + encrypted key vault — secrets server-side / desktop-only, never in browser. *Opus — security-critical.*
- [ ] **P3.2** 🟣 Execution guardrails — position limits, kill-switch, dry-run mode. *Opus.*
- [ ] **P3.3** 🟢 Tauri desktop app — reuse the React app; move key handling + execution here.
- [ ] **P3.4** 🟢 Proxies — vetted pool or bring-your-own on desktop (pending legal).
- [ ] **P3.5** 🟢 Agent trading runtime — let a configured agent manage assets at user's own risk, behind the guardrails.

---

## Phase 4 — Network effects

- [ ] **P4.1** 🟢 Strategy marketplace — publish/browse; one-agent-one-strategy sharing.
- [ ] **P4.2** 🟣 Verified performance ratings — tamper-proof results from real trading; anti-cheat. *Opus — the hard endgame.*
- [ ] **P4.3** 🟣 Copy-trading + leaderboards. *Opus.*
- [ ] **P4.4** 🟢 Learn-by-watching — browser extension logs user actions → structured strategy profile fed back as context (not fine-tuning).

---

## Notes
- Anything touching keys, execution, or money gets tests **before** its box is checked.
- Validate quant output (P1.14/P1.15/P2.3) against a reference (e.g. Coinglass on the same symbol) before trusting it.
- If a task grows past ~a day of work, split it into sub-tasks here so progress stays markable.
