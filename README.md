# «TERMINAL» (working name)

Free, Bloomberg-style trading terminal for crypto and stocks — RU/EN. See `CLAUDE.md` (contract), `TASKS.md` (build tracker), `/docs` (specs).

## Layout

| Path                    | What                                        | Language   |
| ----------------------- | ------------------------------------------- | ---------- |
| `apps/web`              | Landing + terminal (Next.js)                | TypeScript |
| `apps/desktop`          | Tauri shell (Phase 3)                       | Rust       |
| `services/market-data`  | Exchange WS ingestion, order books, fan-out | Go         |
| `services/api-gateway`  | Auth, accounts, billing, WS gateway         | TypeScript |
| `services/quant`        | Backtesting, indicators, spreads, HL map    | Python     |
| `services/ai`           | LLM orchestration, agent runtime            | Python     |
| `services/alert-engine` | Rule evaluation + dispatch                  | TypeScript |
| `services/telegram-bot` | Mini-app backend + alert delivery           | TypeScript |
| `packages/*`            | Shared types, i18n, UI kit, configs         | TypeScript |

## Getting started

Prerequisites: Node ≥22, Docker, a `psql` client on `PATH`.

```bash
corepack enable          # provides pnpm
pnpm install
cp .env.example .env     # fill in locally; never commit

pnpm dev:up               # start Postgres+TimescaleDB & Redis, wait until healthy
pnpm dev:migrate          # apply db/migrate.sh, then set local svc_* role passwords
pnpm dev:seed             # load a few dev instruments (db/dev/seed.sql)

pnpm lint && pnpm build && pnpm test
```

`pnpm dev:reset` wipes local containers/volumes and rebuilds from scratch (up → migrate → seed). `pnpm dev:down` stops containers without deleting data. See `scripts/dev-env.sh` for what each step does.

TS workspaces run through pnpm + Turbo. Go and Python services use their native toolchains (CI jobs added when each service gets real code).

### Running the landing page + gateway locally

Two processes, two terminals (after `dev:up`/`dev:migrate` above):

```bash
pnpm dev:gateway   # api-gateway on :8080
pnpm dev:web       # Next.js on https://localhost:3000
```

Both scripts load the root `.env` themselves (via `dotenv-cli`) — `dev:up`/`dev:migrate` are the only other place `.env` gets read automatically. If you add or change a value in `.env`, restart whichever of `dev:web`/`dev:gateway` you touched; a running dev server does not pick up file changes on its own.

The web app talks to the gateway through a same-origin proxy, not directly —
see `docs/landing-page.md` for why. First visit to `https://localhost:3000`
will show a self-signed-certificate warning unless `mkcert` is installed
(`brew install mkcert && mkcert -install`); either way, click through and
the app works.
