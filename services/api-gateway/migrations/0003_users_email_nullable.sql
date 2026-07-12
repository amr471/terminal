-- api-gateway 0003 — allow email-less users (owner: svc_api_gateway, ADR-005).
--
-- 0001_users_auth.sql anticipated password-less accounts (password_hash is
-- already nullable, "NULL when OAuth-only") but assumed every account has an
-- email. Telegram Login (P1.1) doesn't provide one. Postgres UNIQUE already
-- permits multiple NULLs, so relaxing NOT NULL is sufficient — no index change
-- needed. Google/password signups are unaffected; email stays required there
-- at the application layer, just not enforced in the DB for the Telegram case.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
