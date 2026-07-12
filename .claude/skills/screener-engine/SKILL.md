---
name: screener-engine
description: Use when working on the screener query engine or its filters — the deterministic field·operator·value model, execution over the instrument_state working set, saved screens/presets, and the NL→filter boundary with the LLM.
---

# Screener query engine

First-class feature (CLAUDE.md §6.1). Deterministic end to end: the LLM may
TRANSLATE natural language into a filter definition, but only the engine
EXECUTES filters. No LLM in the hot path, ever.

## The model (source of truth: @terminal/types/src/screener.ts)

- Tree of `numeric` / `categorical` conditions under AND/OR `group` nodes.
- Fields: price, change_1h/24h/7d, volume_24h, market_cap, open_interest,
  funding_rate, volatility_24h, spread (+ categorical exchange, asset_class).
- Values are string decimals (`Dec`), changes are fractions ('-0.05' = -5%).
- Limits enforced by `validateFilterNode`: depth ≤ 5, nodes ≤ 64 — validate
  EVERY definition before storing (screens.definition) or executing,
  especially LLM-produced ones (error GW-2005 on failure).

## Execution

- Working set = `instrument_state` table (one row per instrument, updated in
  place by market-data; `volume_24h DESC` index = the primary sort).
- Engine loads the working set into memory in the gateway and evaluates the
  tree per row; real-time updates re-evaluate on `md.*`-driven state changes
  and push row deltas over the user's WS. Not per-keystroke SQL.
- Decimal comparisons: compare as decimals (not lexicographic strings!) —
  parse `Dec` to a decimal type inside the engine kernel only.

## Canonical example

volume > 100M AND funding < 0 AND change_24h < -5%:
group(and) → [volume_24h gt "100000000", funding_rate lt "0", change_24h lt "-0.05"]

## Grows at

P1.6 (engine, Opus-tagged), P1.7 (UI), NL→filter at P1.16-adjacent.
