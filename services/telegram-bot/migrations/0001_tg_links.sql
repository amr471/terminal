-- telegram-bot 0001 — Telegram account links (owner: svc_telegram_bot, ADR-005).

CREATE TABLE tg_links (
  user_id    uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id bigint      NOT NULL UNIQUE,
  chat_id    bigint      NOT NULL, -- delivery target for alerts
  username   text,                 -- @handle at link time (display only)
  verified   boolean     NOT NULL DEFAULT false, -- deep-link handshake completed
  linked_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX tg_links_active_idx ON tg_links (tg_user_id) WHERE revoked_at IS NULL;

GRANT INSERT, UPDATE, DELETE ON tg_links TO svc_telegram_bot;
