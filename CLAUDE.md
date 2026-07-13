# CLAUDE.md — «TERMINAL» (working name)

Project instructions for Claude Code. This file is loaded every session — treat it as the source of truth for what we're building, how it's built, and the rules you must not break. Detailed reference lives in `/docs/developer-brief.md`.

---

## 1. What this is

A **free, Bloomberg-style trading terminal** for crypto and stocks, serving Russian- and English-speaking traders. Two surfaces: a bilingual marketing **landing page** with the registration form inline (sign-up → straight into the terminal), and the **terminal** itself — a dense, dark, multi-panel workspace where news, screener, spreads, liquidation heatmap, calendar, alerts, and journal are all one glance away.

**Prime directive:** Claude/Sonnet 5 is the _brain and the build tool_, never the number-cruncher. Market math (order books, liquidations, spreads, backtests, alert rules) is deterministic code. The LLM handles language: strategy-from-plain-English, news scoring, the journal, and the agent/chat layer. Never route raw market firehoses through an LLM.

---

## 2. How you (Claude) work in this repo

- **Don't re-litigate decisions in §4.** The stack is fixed. If you think something's wrong, raise it in one sentence, then follow the decision unless told otherwise.
- **Spec → implement → test.** Write a short plan before each feature. Anything touching money, market data, or user secrets gets tests before it's considered done.
- **You are a fast senior engineer, not an autopilot.** The human reviews your code. Optimize for reviewability: small diffs, clear names, comments only where intent isn't obvious.
- **Secrets never enter prompts, logs, or client-side code.** Not user exchange keys, not their Anthropic key, not our vendor keys.
- **Validate quant output against a reference** before trusting it (e.g. eyeball the formula liquidation heatmap against Coinglass on the same symbol).
- **Every third-party feed is assumed unreliable** — always write reconnection, health checks, and graceful degradation.
- **i18n is not optional.** No hardcoded user-facing strings, ever. See §8.

---

## 3. Repository structure (target)

```
/apps
  /web            # Next.js — landing + terminal (TypeScript, React)
  /desktop        # Tauri shell (Phase 3, reuses /web)
/services
  /market-data    # Go — exchange WS ingestion, order books, fan-out
  /api-gateway    # Node or Python — auth, accounts, billing, WS gateway
  /quant          # Python — backtesting, indicators, spreads, real HL map
  /ai             # Python — Sonnet 5 orchestration, BYO-key, agent runtime
  /alert-engine   # rule evaluation + dispatch
  /telegram-bot   # mini-app backend + alert delivery
/packages         # shared TS types, i18n locales, UI kit
/docs             # developer-brief.md and deeper specs
```

---

## 4. Stack (decided — do not change without sign-off)

- **Web app + landing:** TypeScript + React via **Next.js** (SSR for the SEO landing page, SPA terminal).
- **Charting:** TradingView Advanced Charts (approval required, we supply data) or **Lightweight Charts / klinecharts** as the open-source fallback. **ECharts** for the liquidation heatmap.
- **Hot data path:** **Go** (exchange websockets, order-book maintenance, stream fan-out).
- **API / business logic:** Node/TypeScript or Python (**FastAPI**).
- **Quant + AI:** **Python** (pandas, numpy, vectorbt/backtrader; Anthropic SDK, tool use, RAG).
- **Stores:** **PostgreSQL + TimescaleDB** (time-series), **Redis** (cache + pub/sub).
- **Browser transport:** WebSocket.
- **Desktop (Phase 3):** **Tauri** (Rust shell, reuse the React app) — required once exchange keys are handled.
- **Telegram mini-app:** reuse React app + Telegram Web App SDK; bot in Node or Python.

Rule of thumb: TypeScript across the app, Go on the hot path, Python for quant + AI. Don't force one language everywhere.

---

## 5. Design language — Bloomberg-inspired

**Feel:** dark, dense, professional, keyboard-first. Black/near-black base; high-contrast data; the classic Bloomberg amber as a primary accent, with green/red reserved for up/down and long/short. Monospace for all numbers so columns align. Minimal chrome, maximum data. Every panel earns its space.

**Signature elements to build:**

- **Global command bar** (Bloomberg's hallmark): a single input where the user types a symbol + function and jumps anywhere — e.g. `BTC HEAT`, `AAPL CHART`, `ETH NEWS`. Back it with a command palette (fuzzy search over symbols + functions).
- **Persistent top status bar:** New York time (auto EST/EDT); a session strip (Sydney / Tokyo / London / New York) with the active session highlighted and overlaps marked; session importance; a scrolling live-news ticker; a "next high-impact event in Xh" chip. This bar is the daily-retention hook.
- **Dockable multi-panel workspace:** resizable grid, saveable layouts. Default = screener + chart + news.
- **Left icon rail:** Screener · Charts · Liquidation Map · News · Calendar · Journal · Alerts · Marketplace.
- **Right context panel:** details, active alerts, quick actions.

Keep it minimal and legible despite the density — this is Bloomberg refined, not cluttered.

---

## 6. Feature specifications

### 6.1 Screener (crypto + stocks) — first-class feature

- **Columns:** symbol, price, % change (multi-timeframe), volume, market cap, open interest, funding rate, volatility, spread, and more; all **sortable** (sort by volume is a primary use case).
- **Custom filter builder:** users compose filters as `field · operator · value`, combinable with AND/OR groups (e.g. `volume > 100M AND funding < 0 AND change_24h < -5%`). Numeric, percentage, and categorical operators.
- **Saved screens + presets** (e.g. "high-volume losers", "negative funding", "unusual OI").
- **Real-time updates** over WebSocket; virtualized table for thousands of rows.
- **Export** with watermark/referral link (growth mechanic).
- Backed by a deterministic query engine over the market-data store — **no LLM in the screener's hot path.** The LLM may translate a natural-language request into a filter definition, which the engine then executes.

### 6.2 AI agent layer (BYO key)

- Users optionally connect **their own Anthropic API key** (encrypted server-side, never in the browser). Also a managed tier where we supply inference (model token costs before pricing).
- Agents read site data (news, volumes, OI, etc.), analyze, and can **debate** each other. **One agent = one strategy.**
- Agents get **chart access** (via the charting lib) to draw indicators, switch timeframes, and attach indicators per the strategy.
- **NL → strategy spec:** the LLM turns a plain-language idea into a structured strategy the **backtest engine** runs against historical data (crypto, stocks).
- **Learn-by-watching (later):** a browser extension logs the user's actions on a shared account → distilled into a structured **strategy profile** fed back as context (this is behavioral logging + RAG, **not** fine-tuning).
- **Always inject the user's locale** into every prompt so output matches their language.

### 6.3 Liquidation maps (two, kept separate)

- **Formula/Coinglass-style (MVP):** buy from **Coinglass API V4** for launch, or compute from OI + leverage buckets. x=time, y=price, color=estimated liquidation intensity.
- **Real HyperLiquid map (Phase 2 differentiator):** pull actual on-chain positions from HyperLiquid's public info API, cluster wallets, **separate whales from small traders** so real liquidation/stop levels are visible. Present the two maps side by side — the gap between them is signal.

### 6.4 News, sessions & economic calendar

- **News parser** aggregating all sources: crypto news APIs, **Telegram** channels (MTProto), **Arkham** on-chain intel, and more; deduped and normalized. LLM tags relevance/sentiment/asset and answers "what does this mean for my positions?"
- **Sessions:** show the active session; allow pulling up a live stream or news for scheduled meetings.
- **Economic calendar** (Forex-Factory-style): daily events with session, importance tier, forecasts, previous/actual. Include RU-language sources for the RU market.

### 6.5 Alerts + Telegram mini-app

- Deterministic **alert engine** (price, indicator, liq-level, news triggers), dispatched to web **and** Telegram.
- **Telegram mini-app:** condensed view — user logs in, sees all alerts, manages them; alerts also delivered to Telegram.

### 6.6 Trading / execution (Phase 3)

- Users add **exchange API keys** so an agent can manage assets **at their own risk**. Requires the **Tauri desktop app** — secrets and execution do not belong in a browser.
- **Guardrails:** position limits, kill-switch, dry-run mode.
- **Proxies:** provide a vetted pool or let desktop users connect their own (legal review first).

### 6.7 Journal, marketplace, analytics, export

- **Automatic trader's journal** (auto-log from connected APIs + manual entries); LLM surfaces patterns/mistakes.
- **Strategy marketplace** (Phase 4): share strategies; **rating from real, verified trading results** (anti-cheat is the hard part — treat as endgame).
- **Analytics** dashboards (PnL, win rate, drawdown).
- **Viral export:** shareable cards with watermark/referral links.

### 6.8 Auth & accounts (P1.1, implemented)

Email+password (argon2id) plus Google and Telegram OAuth, opaque session
tokens (not JWT), single `oauth_accounts` table for both providers. See
`/docs/auth.md` for the session model, endpoint list, and account-linking
rules.

### 6.9 Gateway REST + WS (P1.2, implemented)

`api-gateway` exposes a single authenticated `/ws` endpoint (session cookie,
same as REST) that browsers subscribe/unsubscribe on by `md.*` channel name
— never arbitrary Redis channels or `evt.*` streams directly. A REST
snapshot endpoint (`/md/snapshot/:exchange/:symbol`) gives first-paint state
from the same cache keys market-data (P1.5a) will populate. See
`/docs/gateway-ws.md` for the wire protocol, auth/backpressure/heartbeat
behavior, and current known-empty state until P1.5a lands.

### 6.10 Landing page (P1.2a, implemented)

Bilingual (`/en`, `/ru`) SSR marketing page in `apps/web` (Next.js App
Router) with the registration form inline, posting to the gateway via a
same-origin rewrite proxy (`next dev --experimental-https` + `/api/*`
rewrites) so the Secure session cookie round-trips without weakening it or
adding CORS to the gateway. See `/docs/landing-page.md` for the locale
routing approach, the HTTPS proxy rationale, and current test-coverage
scope.

### 6.11 Terminal shell (P1.3, implemented; tabs added at P1.3a)

Session-gated `/[locale]/terminal`: top status bar, left icon rail, command
bar, a browser-style workspace tab strip (P1.3a — switch/reorder/rename/
close, each tab its own saved layout), and a resizable/saveable panel grid
per tab (`layouts` table, now N rows per user instead of P1.3's one) with
placeholder Screener/Chart/News panels ahead of those features landing at
P1.6–P1.10. See `/docs/terminal-shell.md` for the layout data model (columns
of stacked panels, not a general drag-and-drop grid), the resize
implementation, the `/layouts/tabs` REST surface, and the session-gating
approach.

---

## 7. Data sources (verify current terms/pricing before wiring)

- **Derivatives (OI, funding, liquidation heatmaps/maps, L2/L3 order books, HyperLiquid whale intel):** Coinglass API V4 — base `open-api-v4.coinglass.com`, header `CG-API-KEY`. Buy the heatmap for MVP.
- **Prices/candles/order books (free):** Binance / Bybit / OKX websockets.
- **Real HL map:** HyperLiquid public info API.
- **News:** CryptoPanic (impact tagging), CoinGecko News API (multi-locale, good for RU/EN), APITube / NewsData.io (sentiment + entities); Telegram via Telethon/Pyrogram; Arkham API.
- **Economic calendar:** Trading Economics API (forecasts, point-in-time), FXStreet API (OAuth2 + webhooks), Finnhub (free tier). Forex Factory has no official API.
- **Sessions clock:** computed from timezones, no API.

---

## 8. Internationalization (RU/EN, from the first commit)

- i18n framework (next-intl / i18next); locale files in `/packages`. No hardcoded strings.
- Localize numbers, dates, timezones. Keep the user's timezone separate from the fixed NY session clock.
- **LLM features respond in the user's selected language** (locale in the prompt).
- Source RU-language news/Telegram channels explicitly.

---

## 9. Security & compliance — non-negotiable

- Secrets (user exchange keys, user/vendor API keys) encrypted at rest, used server-side or in the Tauri app only, **never in the browser or in prompts/logs**.
- Live trading requires the desktop app + explicit guardrails.
- **Legal/compliance review before Phase 3** — "at the user's own risk" is not a full shield once we touch execution.
- **Buy before build** where a vendor already sells the data well (Coinglass); build only what differentiates us (real HL map, AI strategy loop, UX).

---

## 10. Build phases

1. **MVP (no live money):** landing → auth → terminal shell + top status bar + command bar → **screener (with custom filters + volume sort)** → charts → news + LLM scoring → economic calendar → alerts (web + Telegram bot) → Coinglass liquidation heatmap (bought) → NL→strategy + backtesting → subscriptions.
2. **Market-intelligence edge:** order-book aggregation → spreads/arbitrage → real HyperLiquid map → Telegram mini-app → journal + viral export.
3. **Execution:** exchange APIs → Tauri desktop app → guardrails → proxies.
4. **Network effects:** marketplace → verified ratings → copy-trading.

---

## 11. Skills

Skills are on-demand capability packages (`SKILL.md` + optional scripts). Project skills live in `.claude/skills/` (committed, team-shared); personal ones in `~/.claude/skills/`.

- **We source skills from marketplaces, not by authoring from scratch.** Primary sources: `github.com/alirezarezvani/claude-skills` (add as a plugin marketplace) and `claudeskills.info` (directory). Full catalog and install commands in `/docs/skills.md`.
- **Security-audit every third-party skill before committing it** — this repo will eventually touch exchange keys. Run a skill security scan and read the `SKILL.md` before it goes in `.claude/skills/`.
- **Load `senior-frontend` before building any UI** (the marketplace has no "frontend-design" skill; `senior-frontend` is its equivalent — vetted and vendored at F0.5), so the Bloomberg aesthetic stays distinctive rather than defaulting to generic.
- A few crypto-domain skills (Coinglass V4, HyperLiquid data, the screener query model, the liquidation-heatmap formula) won't exist on any marketplace — author those locally as the project matures.
- **If a task would benefit from a skill that isn't installed** — any domain: languages, trading, design, testing — name it in the task plan and ask John to add it. He installs skills on request; don't improvise around a missing skill. (Go work: the full `golang-*` suite is installed; start from `golang-how-to`.)

---

## 12. Adding features & evolving this project

Pick the right home for each change; don't put everything in this file (it's loaded every session, so keep it lean).

- **A durable decision, rule, convention, or scope change** (new phase item, a new non-negotiable, a stack choice) → edit **this file** (`CLAUDE.md`). It's the always-loaded contract.
- **A large feature with real detail** (schemas, flows, endpoints) → write a short spec in **`/docs/<feature>.md`** and add a one-line pointer here. Keeps the detail out of the always-loaded context.
- **Reusable procedural know-how** (how to call an API, a repeatable workflow) → make it a **skill** in `.claude/skills/`, so it loads only when relevant.
- **A one-off task** (fix this bug, build this component) → just prompt in the Claude Code session; nothing to persist.

Rule of thumb: _contract → CLAUDE.md; detail → /docs; repeatable how-to → skill; one-off → just ask._ When you add a feature, first decide which of these it is, update that home, then implement.
