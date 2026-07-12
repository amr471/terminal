---
name: coinglass-v4
description: Use when integrating or querying the Coinglass API V4 — liquidation heatmaps, open interest, funding rates, or any derivatives data we buy rather than build. Covers auth, endpoints, rate limits, and how responses map to our hypertables and Redis channels.
---

# Coinglass API V4

Buy-don't-build source for derivatives data (CLAUDE.md §7/§9): liquidation
heatmap for P1.14, OI/funding backfill, HyperLiquid whale intel later.

## Auth & transport

- Base: `https://open-api-v4.coinglass.com`
- Header: `CG-API-KEY: <key>` — key lives in `COINGLASS_API_KEY` env var,
  used only inside `services/market-data`. **Never in logs, prompts, or the
  browser** (CLAUDE.md §9). Responses are `{"code":"0","msg":"success","data":...}`;
  treat any non-"0" code as an error, log the msg only.
- Plans are rate-limited per minute: budget client-side, honor 429 with the
  §5.1 backoff. REST polling only at our tier (no public WS).

## Endpoints we use (VERIFY paths against current docs + plan tier before wiring)

| Purpose | Path (V4) | Maps to |
| --- | --- | --- |
| Liquidation heatmap (bought, MVP) | `/api/futures/liquidation/heatmap` | ECharts panel via gateway; Redis cache TTL ~60s |
| Aggregated OI | `/api/futures/open-interest/aggregated-history` | `oi` hypertable |
| Funding rates | `/api/futures/funding-rate/history` | `funding` hypertable |
| Liquidation history | `/api/futures/liquidation/aggregated-history` | `liq_events` (src='coinglass') |

## Conventions

- Poller = a `conn.Feed` implementation (interval feed) so it inherits
  backoff/staleness/health from `internal/conn` for free.
- All numerics → string decimals (`norm.Dec`) at the normalization boundary.
- Validate the bought heatmap against the Coinglass UI on the same symbol
  before trusting the rendering pipeline (CLAUDE.md §2).

## Grows at

P1.14 (heatmap), P2.3 (vs the real HyperLiquid map).
