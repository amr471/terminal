-- api-gateway 0004 — layouts become tabs (P1.3a, owner: svc_api_gateway,
-- ADR-005). P1.3 modeled "the user's workspace" as exactly one layout row
-- per user (`is_default`, enforced by a partial unique index). P1.3a
-- generalizes that to N named, orderable, closable tabs: every row is now
-- one tab. `name` stays the internal (server-generated, unique-per-user)
-- identifier; `title` is the new user-facing, renameable label. `is_active`
-- replaces `is_default` as "which tab is currently shown" — same
-- one-true-row-per-user shape, new name to match.

ALTER TABLE layouts
  ADD COLUMN title      text    NOT NULL DEFAULT 'Main',
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN is_active  boolean NOT NULL DEFAULT false;

-- Backfill: every existing row was the user's one-and-only (default) layout,
-- so it becomes tab 0, titled 'Main', active — same title used by the
-- lazy-provision path in layouts.ts when a user with zero tabs first hits
-- GET /layouts/tabs, so newly- and previously-provisioned users match.
UPDATE layouts SET title = 'Main', sort_order = 0, is_active = true WHERE is_default;

DROP INDEX layouts_one_default_per_user;
ALTER TABLE layouts DROP COLUMN is_default;

CREATE UNIQUE INDEX layouts_one_active_per_user
  ON layouts (user_id) WHERE is_active;

CREATE INDEX layouts_user_order_idx ON layouts (user_id, sort_order);
