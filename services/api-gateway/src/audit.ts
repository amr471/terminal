/**
 * audit_log writer (trading-security skill: "audit events to audit_log — meta
 * must be secret-free"). Every auth-relevant action goes through here so the
 * check happens in one place instead of at every call site.
 */
import type pg from 'pg';

/** Keys that must never appear in audit_log.meta, even truncated/hashed-looking. */
const FORBIDDEN_META_KEY_PATTERN = /password|token|secret|ciphertext|nonce|api[-_]?key/i;

export type AuditEvent = 'auth.signup' | 'auth.login' | 'auth.login_failed' | 'auth.logout';

export function assertSecretFreeMeta(meta: Record<string, unknown>): void {
  for (const key of Object.keys(meta)) {
    if (FORBIDDEN_META_KEY_PATTERN.test(key)) {
      throw new Error(`audit meta key "${key}" looks secret-bearing; refusing to log`);
    }
  }
}

export async function recordAuditEvent(
  db: pg.Pool,
  event: AuditEvent,
  userId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  assertSecretFreeMeta(meta);
  await db.query('INSERT INTO audit_log (user_id, event, meta) VALUES ($1, $2, $3)', [
    userId,
    event,
    JSON.stringify(meta),
  ]);
}
