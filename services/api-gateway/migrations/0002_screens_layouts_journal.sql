-- api-gateway 0002 — screener definitions, workspace layouts, trader's journal
-- (owner: svc_api_gateway, ADR-005).

-- Saved screener filters. `definition` is the deterministic filter model from
-- P1.6 (field·operator·value with AND/OR groups) — validated against the JSON
-- schema in @terminal/types before insert. The LLM may PRODUCE a definition
-- (NL → filter), but the query engine only ever executes the stored structure.
CREATE TABLE screens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        REFERENCES users(id) ON DELETE CASCADE, -- NULL = built-in preset
  name       text        NOT NULL,
  definition jsonb       NOT NULL,
  is_preset  boolean     NOT NULL DEFAULT false,
  sort_key   text,                 -- default sort column, e.g. 'volume_24h'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (is_preset = (user_id IS NULL))
);

CREATE INDEX screens_user_idx ON screens (user_id) WHERE deleted_at IS NULL;

-- Saved terminal layouts (dockable grid state, CLAUDE.md §5).
CREATE TABLE layouts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  definition jsonb       NOT NULL, -- panel grid, sizes, panel configs
  is_default boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE UNIQUE INDEX layouts_one_default_per_user
  ON layouts (user_id) WHERE is_default;

-- Trader's journal (§6.7): auto-logged from connected APIs + manual entries.
-- The ai service READS these (evt.journal_entry carries ids, not rows) to surface
-- patterns; it never writes here.
CREATE TABLE journal_entries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL DEFAULT now(), -- trade/entry time
  source      text        NOT NULL DEFAULT 'manual' CHECK (source IN ('auto','manual')),
  symbol      text,
  exchange    text,
  side        text        CHECK (side IN ('long','short')),
  entry_price numeric,
  exit_price  numeric,
  qty         numeric,
  pnl         numeric,
  notes       text,
  tags        text[]      NOT NULL DEFAULT '{}',
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX journal_user_ts_idx ON journal_entries (user_id, ts DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX journal_tags_idx ON journal_entries USING gin (tags);

GRANT INSERT, UPDATE, DELETE ON screens, layouts, journal_entries TO svc_api_gateway;
