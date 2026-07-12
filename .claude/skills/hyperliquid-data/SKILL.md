---
name: hyperliquid-data
description: Use when pulling real on-chain position data from HyperLiquid's public info API — the P2.3 differentiator (real liquidation map, whale vs retail separation). Covers info endpoint request types, wallet enumeration, and the clustering plan.
---

# HyperLiquid public info API

The real-positions source behind P2.3: actual liquidation/stop levels from
on-chain data, whales separated from retail, rendered side-by-side with the
formula/Coinglass map — the gap between the two maps is the signal.

## Transport

- Single endpoint: `POST https://api.hyperliquid.xyz/info` with JSON body
  `{"type":"<requestType>", ...}`. Public info needs no auth. WS at
  `wss://api.hyperliquid.xyz/ws` for subscriptions.
- Rate limits are IP-based (VERIFY current numbers before bulk pulls);
  batch + cache aggressively — this is a Phase-2 batch pipeline, not hot path.

## Request types

| Type | Returns | Use |
| --- | --- | --- |
| `clearinghouseState` (per user) | open positions, leverage, liq price | the position map |
| `metaAndAssetCtxs` | universe, funding, OI per asset | context + sanity checks |
| `l2Book` | book snapshot | side-channel |
| `fundingHistory` | funding series | `funding` hypertable (src='hyperliquid') |

Wallet enumeration: seed from leaderboard + large-fill tracking; cluster by
notional (whale ≥ $1M starting threshold — tune with data); refresh positions
on a rate-limit-budgeted interval.

## Conventions

- Lives in `services/quant` (Python, batch), not market-data (Go, hot).
  Output → Postgres; rendered maps → Redis cache.

## Grows at

P2.3. Related: coinglass-v4 (the formula map to compare against).
