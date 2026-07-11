# «TERMINAL» (working name)

Free, Bloomberg-style trading terminal for crypto and stocks — RU/EN. See `CLAUDE.md` (contract), `TASKS.md` (build tracker), `/docs` (specs).

## Layout

| Path | What | Language |
| --- | --- | --- |
| `apps/web` | Landing + terminal (Next.js) | TypeScript |
| `apps/desktop` | Tauri shell (Phase 3) | Rust |
| `services/market-data` | Exchange WS ingestion, order books, fan-out | Go |
| `services/api-gateway` | Auth, accounts, billing, WS gateway | TypeScript |
| `services/quant` | Backtesting, indicators, spreads, HL map | Python |
| `services/ai` | LLM orchestration, agent runtime | Python |
| `services/alert-engine` | Rule evaluation + dispatch | TypeScript |
| `services/telegram-bot` | Mini-app backend + alert delivery | TypeScript |
| `packages/*` | Shared types, i18n, UI kit, configs | TypeScript |

## Getting started

```bash
corepack enable          # provides pnpm
pnpm install
pnpm lint && pnpm build && pnpm test
cp .env.example .env     # fill in locally; never commit
```

TS workspaces run through pnpm + Turbo. Go and Python services use their native toolchains (CI jobs added when each service gets real code).
