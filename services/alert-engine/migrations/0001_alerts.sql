-- alert-engine 0001 — alert rules + fire history (owner: svc_alert_engine, ADR-005).
-- Rules are DETERMINISTIC (CLAUDE.md §6.5): `rule` holds a structured condition tree
-- (price/indicator/liq-level/news triggers) validated against @terminal/types.
-- No LLM in the evaluation path.

CREATE TABLE alerts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  rule        jsonb       NOT NULL,
  channels    text[]      NOT NULL DEFAULT '{web}', -- subset of {web,telegram}
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','triggered_once')),
  cooldown_s  integer     NOT NULL DEFAULT 60, -- min seconds between fires
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CHECK (channels <@ ARRAY['web','telegram']::text[])
);

CREATE INDEX alerts_active_idx ON alerts (status)
  WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX alerts_user_idx ON alerts (user_id) WHERE deleted_at IS NULL;

-- Fire history. Insert-heavy, time-ordered → hypertable with retention.
CREATE TABLE alert_history (
  alert_id  uuid        NOT NULL, -- no FK: history must survive alert hard-deletes;
                                  -- integrity is the engine's job (single writer)
  user_id   uuid        NOT NULL,
  fired_at  timestamptz NOT NULL DEFAULT now(),
  payload   jsonb       NOT NULL, -- what fired: values, thresholds, feed states
  delivery  jsonb       NOT NULL DEFAULT '{}'::jsonb -- per-channel delivery status
);

SELECT create_hypertable('alert_history', 'fired_at', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX alert_history_alert_idx ON alert_history (alert_id, fired_at DESC);
CREATE INDEX alert_history_user_idx ON alert_history (user_id, fired_at DESC);
SELECT add_retention_policy('alert_history', INTERVAL '180 days');

GRANT INSERT, UPDATE, DELETE ON alerts, alert_history TO svc_alert_engine;
-- The gateway creates/edits alert definitions on behalf of users via the engine's
-- HTTP API (single writer) — NOT by writing this table directly.
