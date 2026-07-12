---
name: i18n-ru-en
description: Use when adding or reviewing ANY user-facing string, RU/EN translation, number/date/percent formatting, or locale handling. No hardcoded strings anywhere — this skill is the enforcement guide.
---

# RU/EN internationalization

CLAUDE.md §8: i18n is not optional, from the first commit. All copy lives in
`@terminal/i18n` catalogs; components receive t()-resolved text.

## Adding a string

1. Add the key to `packages/i18n/src/catalogs/en.ts` (the reference catalog —
   its keys define `MessageKey`).
2. Add the RU translation to `ru.ts` — it's typed `Catalog`, so a missing key
   fails the build; tests also diff the key sets.
3. Plural-sensitive messages use CLDR forms: en {one, other}; ru {one, few,
   many, other} — 1 результат / 2 результата / 5 результатов / 21 результат.
4. Use `t(locale, key, params)`; params interpolate {name} placeholders.

## Formatting rules (packages/i18n/src/format.ts)

- Numbers: `formatDec` — string-decimal-safe, never through Number. RU groups
  with NBSP and uses comma decimals (64 123,50).
- Percents: `formatPercentFromFraction('-0.052')` → '-5.2%' / '-5,2 %'
  (NBSP before % in RU). Values are FRACTIONS in data, % only at display.
- `formatCompact` is display-only (floats) — never feed output back to math.
- User timezone: `time.ts` (formatDateTime/formatAge). Market sessions:
  `sessions.ts` — FIXED exchange-local clocks; user tz plays no role there.

## LLM features

Inject the user's locale into every prompt (see agent-runtime skill); RU news
sources are first-class (CLAUDE.md §6.4), not translations of EN feeds.

## Review checklist

No string literals in JSX/UI code · en+ru both updated · plurals correct ·
numbers via formatDec/NumCell · dates in user tz · session clock untouched.
