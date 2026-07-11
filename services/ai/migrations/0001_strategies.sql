-- ai 0001 — strategies + agent configs (owner: svc_ai, ADR-005).

-- A strategy is a STRUCTURED spec (NL → strategy, §6.2): the LLM produces it once;
-- the backtest engine (quant) executes it deterministically. One agent = one strategy.
CREATE TABLE strategies (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  spec        jsonb       NOT NULL,  -- structured spec, schema in @terminal/types
  spec_version integer    NOT NULL DEFAULT 1,
  source      text        NOT NULL DEFAULT 'nl'
                          CHECK (source IN ('nl','manual','imported','learned')),
  source_text text,                  -- original plain-language idea (for provenance)
  locale      text        NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ru')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX strategies_user_idx ON strategies (user_id) WHERE deleted_at IS NULL;

CREATE TABLE agent_configs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id uuid        NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  model       text        NOT NULL DEFAULT 'claude-sonnet-5',
  params      jsonb       NOT NULL DEFAULT '{}'::jsonb, -- temperature, tools, chart access
  key_mode    text        NOT NULL DEFAULT 'byo' CHECK (key_mode IN ('byo','managed')),
  status      text        NOT NULL DEFAULT 'idle'
                          CHECK (status IN ('idle','running','paused','error')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- one agent = one strategy (per user a strategy can back only one agent)
  UNIQUE (user_id, strategy_id)
);

CREATE INDEX agent_configs_user_idx ON agent_configs (user_id);

GRANT INSERT, UPDATE, DELETE ON strategies, agent_configs TO svc_ai;
