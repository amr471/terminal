---
name: agent-runtime
description: Use when building the AI agent layer in services/ai — BYO-key handling, one-agent-one-strategy, locale injection, tool access to site data and charts, agent debates, and NL→strategy spec production. The LLM is the brain, never the number-cruncher.
---

# Agent runtime (services/ai)

CLAUDE.md §6.2 + prime directive: Sonnet 5 handles language and reasoning;
market math is deterministic code. Never route `md.*` firehoses into prompts.

## Hard rules

- **One agent = one strategy** (`agent_configs.strategy_id` UNIQUE per user).
- **BYO key**: user Anthropic keys decrypt only inside api-gateway; ai gets
  them per-request over the private network, holds them in memory only.
  Keys never appear in prompts, logs, traces, or error messages (AI-4002 on
  invalid key). Managed tier uses our vendor key with per-user metering.
- **Locale injection**: EVERY prompt includes the user's locale; responses
  come back in that language (@terminal/i18n owns the locale value).
- Agents read SITE data (news items, scored sentiment, OI/volume summaries,
  backtest results) — pre-digested, bounded snapshots, not raw streams.

## What agents produce

- **Strategy specs**: structured `StrategySpec` (@terminal/types) validated
  with AI-4003 on failure; quant executes them deterministically (P1.15/16).
- **Screener filters**: `ScreenDefinition` trees, validated before execution.
- **Analysis/debate**: agents argue positions using the same bounded data;
  debate = N agents + a moderator summarizer, transcripts stored per user.
- **Chart actions**: tool calls that drive the charting lib (draw indicator,
  switch timeframe) — a constrained tool schema, not free-form JS.

## Grows at

P1.10 (news scoring), P1.16 (NL→strategy), P2.6 (journal insights),
P3.5 (trading runtime behind guardrails), P4 (marketplace).
