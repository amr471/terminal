/**
 * Postgres pool for api-gateway. Connects as svc_api_gateway (ADR-005 single
 * writer) — this process may only write users/oauth_accounts/sessions/
 * subscriptions/api_keys/audit_log/screens/layouts/journal_entries; every
 * other table is read-only to it.
 */
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on('error', (err) => {
  // A dropped idle client shouldn't crash the process — surfaces in health checks instead.
  console.error('[api-gateway] unexpected Postgres pool error:', err.message);
});
