-- api-gateway 0001 — users, auth, subscriptions, encrypted key vault
-- (owner: svc_api_gateway, ADR-005).

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext      NOT NULL UNIQUE,
  password_hash text,                 -- NULL when OAuth-only
  locale        text        NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ru')),
  tz            text        NOT NULL DEFAULT 'UTC', -- IANA zone; NY session clock stays fixed
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz            -- soft delete
);

CREATE INDEX users_active_idx ON users (created_at) WHERE deleted_at IS NULL;

CREATE TABLE oauth_accounts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            text        NOT NULL, -- 'google' | 'github' | 'telegram' | ...
  provider_account_id text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);

CREATE TABLE sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE, -- SHA-256 of the session token; raw token never stored
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip         inet,
  user_agent text
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at); -- reaper scans

CREATE TABLE subscriptions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier               text        NOT NULL DEFAULT 'free'
                                 CHECK (tier IN ('free','pro','managed_ai')),
  status             text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','past_due','canceled','trialing')),
  current_period_end timestamptz,
  payment_provider   text,       -- 'stripe' | ... (decided at P1.17)
  payment_ref        text,       -- provider's subscription id; NEVER card data
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscriptions_one_active_per_user
  ON subscriptions (user_id) WHERE status IN ('active','trialing','past_due');

-- ── encrypted key vault (CLAUDE.md §9) ───────────────────────────────────────
-- Ciphertext only. AES-256-GCM performed in the gateway process with a master key
-- from the environment/KMS — the DB never sees plaintext. Plaintext keys never
-- appear in logs, prompts, or the browser. Exchange keys additionally require the
-- desktop app (Phase 3) before they are accepted at all.
CREATE TABLE api_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('anthropic','exchange')),
  exchange    text,                  -- non-null iff kind='exchange'
  label       text,
  ciphertext  bytea       NOT NULL,  -- AES-256-GCM(key material)
  nonce       bytea       NOT NULL,
  key_version integer     NOT NULL DEFAULT 1, -- master-key rotation support
  last4       text,                  -- display hint only
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CHECK (kind <> 'exchange' OR exchange IS NOT NULL)
);

CREATE INDEX api_keys_user_active_idx ON api_keys (user_id) WHERE revoked_at IS NULL;

-- ── audit log (append-only) ──────────────────────────────────────────────────
CREATE TABLE audit_log (
  id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  event   text        NOT NULL,            -- 'auth.login', 'key.added', 'key.revoked', ...
  meta    jsonb       NOT NULL DEFAULT '{}'::jsonb -- MUST NOT contain secrets
);

CREATE INDEX audit_log_user_ts_idx ON audit_log (user_id, ts DESC);

GRANT INSERT, UPDATE, DELETE
  ON users, oauth_accounts, sessions, subscriptions, api_keys, audit_log
  TO svc_api_gateway;
