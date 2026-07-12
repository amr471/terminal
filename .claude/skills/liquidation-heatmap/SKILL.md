---
name: liquidation-heatmap
description: Use when computing or rendering the formula-based liquidation heatmap — OI + leverage-bucket estimation, liq price math, ECharts rendering, and validation against Coinglass. The bought Coinglass heatmap is the MVP; this formula is the fallback/cross-check.
---

# Liquidation heatmap (formula / Coinglass-style)

CLAUDE.md §6.3: x = time, y = price, color = estimated liquidation intensity.
MVP buys Coinglass's heatmap (see coinglass-v4); this skill owns the formula
we compute ourselves as fallback and cross-check.

## The estimation model

For each OI change at price P, distribute the new positions across standard
leverage buckets (10x, 25x, 50x, 100x — weights tunable) and mark estimated
liquidation prices:

- Long liq ≈ P × (1 − 1/L + mmr)   ·   Short liq ≈ P × (1 + 1/L − mmr)
  (L = leverage, mmr = maintenance margin rate per exchange/tier)
- Intensity at a price level accumulates until price trades through it
  (liquidations consumed) — decay clusters the market has crossed.
- All math in `services/quant` with Decimal; string decimals at boundaries.

## Rendering

- ECharts heatmap (CLAUDE.md §4) in the terminal panel; data from gateway,
  cached in Redis (`cache:` keys, short TTL). Color ramp: dark → amber
  (use design tokens; green/red stay reserved for direction).

## Validation (non-negotiable, CLAUDE.md §2)

Before trusting output: render our map and Coinglass's for the same symbol
and time window and eyeball-diff cluster positions. Document discrepancies;
tune bucket weights/mmr until major clusters align.

## Grows at

P1.14 (bought map first), formula version alongside, P2.3 (real HL map).
