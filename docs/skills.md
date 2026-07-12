# Skills catalog

Status: Accepted (F0.7) · Owner: John · Last updated: 2026-07-12
Companion to `CLAUDE.md` §11. Project skills live in `.claude/skills/`
(committed, team-shared). **Every third-party skill is security-audited
before it lands here**; verdicts are recorded below.

## Sources

- **`github.com/alirezarezvani/claude-skills`** — primary marketplace
  (engineering-team, product-team, marketing bundles). Add as a plugin
  marketplace in Claude Code: `/plugin marketplace add alirezarezvani/claude-skills`,
  or copy individual skills into `.claude/skills/` (our approach — we vendor
  vetted copies so the repo is self-contained and audit state is frozen).
- **`claudeskills.info`** — directory for discovering skills across
  marketplaces; install always goes through the audit procedure below.
- **`samber/cc-skills-golang`** — the `golang-*` suite (installed by John at
  the plugin level, not vendored here). Entry point: `golang-how-to`.

## Install & audit procedure

1. Clone/fetch the skill to a temp dir.
2. Run the `skill-security-auditor` scan on it.
3. **PASS** → copy to `.claude/skills/`. **WARN/FAIL** → read every finding;
   only install if each one is a verified false positive (record it below).
   Real hits: don't install, no exceptions — this repo will touch exchange keys.
4. Read the SKILL.md yourself before committing (auditor catches patterns,
   not intent).
5. Record the skill + verdict in this file.

## Installed third-party skills (vendored, audited)

| Skill             | Source bundle    | Audit verdict                | Notes                                                                                                                                                                                                         |
| ----------------- | ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `senior-frontend` | engineering-team | WARN → accepted              | 1 HIGH false positive: "npm install" is a printed next-step string in frontend_scaffolder.py, never executed. Use before all UI work (Bloomberg aesthetic, CLAUDE.md §5/§11).                                 |
| `senior-backend`  | engineering-team | PASS                         | Gateway/API work (P1.1/P1.2).                                                                                                                                                                                 |
| `tdd-guide`       | engineering-team | PASS                         | Money/market-data/secrets code is test-first (CLAUDE.md §2).                                                                                                                                                  |
| `code-reviewer`   | engineering-team | PASS                         | Pre-commit review passes on risky diffs.                                                                                                                                                                      |
| `senior-security` | engineering-team | FAIL → accepted after review | 2 CRITICAL false positives: `__import__('datetime')` lazy stdlib imports (constant string) in secret_scanner.py:384 and threat_modeler.py:468 — not dynamic code execution. Re-verify on any upstream update. |

## Local crypto-domain skills (authored here — no marketplace has these)

| Skill                 | Covers                                                                       | Grows at                          |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| `coinglass-v4`        | Coinglass API V4 auth/endpoints/limits → hypertables                         | P1.14, P2.3                       |
| `hyperliquid-data`    | HL public info API, wallet clustering plan                                   | P2.3                              |
| `exchange-websockets` | Binance/Bybit/OKX WS formats, ping/seq rules, conn.Feed integration          | P1.6/P1.8, P2.1                   |
| `screener-engine`     | Deterministic filter model, working-set execution, NL→filter boundary        | P1.6/P1.7                         |
| `liquidation-heatmap` | OI+leverage-bucket formula, ECharts, Coinglass validation                    | P1.14                             |
| `agent-runtime`       | BYO-key rules, one-agent-one-strategy, locale injection, tool schemas        | P1.10/P1.16, P2.6, P3.5           |
| `i18n-ru-en`          | Catalog workflow, plural rules, formatting, review checklist                 | every UI/copy task                |
| `trading-security`    | §9 operationalized: vault mechanics, auth rules, Phase-3 gates, PR checklist | every secrets/auth/execution task |

## Conventions

- Stubs carry real starter content (decided endpoints, conventions, math) and
  a "Grows at" section naming the tasks that flesh them out — update the
  skill in the same PR as the feature.
- `VERIFY` markers inside skills flag facts that must be re-checked against
  live vendor docs before wiring (terms/pricing/paths change; CLAUDE.md §7).
- Missing a skill for a task? Ask John — he installs on request
  (CLAUDE.md §11). Don't improvise around a gap.
