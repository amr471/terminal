---
name: trading-security
description: Use when touching ANYTHING involving secrets, API keys, auth, billing, or (Phase 3) live trading — the operational checklist that enforces CLAUDE.md §9. Load this for every PR in api-gateway auth/vault code and all Phase-3 work.
---

# Trading security (CLAUDE.md §9 operationalized)

Non-negotiables with the concrete mechanics this repo uses.

## Secrets

- User keys (Anthropic, exchange) → `api_keys` table, AES-256-GCM ciphertext
  + nonce + key_version only. Master key from env/KMS (`VAULT_MASTER_KEY`),
  never committed. Rotation = new key_version, background re-encrypt.
- Plaintext exists only in gateway process memory (and desktop app in P3).
  NEVER in: browser, Redis, logs, prompts, error messages, audit_log.meta,
  git. `last4` is the only displayable fragment.
- Vendor keys (Coinglass etc.) → env vars in the owning service only.
- Every `.env.example` documents variables WITHOUT values.

## Auth (P1.1)

- Session tokens: random ≥256-bit, stored as SHA-256 in `sessions.token_hash`;
  raw token only in the httpOnly Secure SameSite cookie.
- Passwords: argon2id. OAuth accounts in `oauth_accounts`.
- Rate-limit auth endpoints (GW-2004); audit events (`auth.login`,
  `key.added`, `key.revoked`) to `audit_log` — meta must be secret-free.

## Phase-3 gates (execution)

- ⛔ P3.0 legal review sign-off BEFORE any exchange-key code merges.
- Exchange keys + execution only in the Tauri desktop app, never browser.
- Guardrails are code, not policy: position limits, kill-switch, dry-run
  default-on. Every execution path needs tests before its box is checked.

## PR checklist (anything touching money/keys/auth)

Tests exist and pass · no secret in any log line or error string · new tables
follow single-writer grants · encryption at rest for any credential ·
rate limits on new public endpoints · audit events emitted.
