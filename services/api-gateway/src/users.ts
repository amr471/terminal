/**
 * User + OAuth account persistence. All queries are parameterized (no string
 * interpolation of user input — trading-security / senior-backend baseline).
 */
import type pg from 'pg';
import type { Locale } from '@terminal/types';

export interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  locale: Locale;
  display_name: string | null;
}

export async function findUserByEmail(db: pg.Pool, email: string): Promise<UserRow | null> {
  const res = await db.query<UserRow>(
    `SELECT id, email, password_hash, locale, display_name
     FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );
  return res.rows[0] ?? null;
}

export async function createUserWithPassword(
  db: pg.Pool,
  input: { email: string; passwordHash: string; locale: Locale; displayName?: string },
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.email, input.passwordHash, input.locale, input.displayName ?? null],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('user insert returned no id');
  return id;
}

export async function findOAuthUserId(
  db: pg.Pool,
  provider: string,
  providerAccountId: string,
): Promise<string | null> {
  const res = await db.query<{ user_id: string }>(
    `SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2`,
    [provider, providerAccountId],
  );
  return res.rows[0]?.user_id ?? null;
}

/**
 * Links `provider`/`providerAccountId` to an existing user matched by email
 * (only when `email` is provided and verified upstream — callers must ensure
 * that before calling this), or creates a brand-new user if no match exists.
 * Runs in a transaction so a partial user+link never lands on a crash.
 */
export async function linkOrCreateOAuthUser(
  db: pg.Pool,
  provider: string,
  providerAccountId: string,
  profile: { email: string | null; displayName?: string; locale: Locale },
): Promise<{ userId: string; created: boolean }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let userId: string | undefined;
    if (profile.email) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [profile.email],
      );
      userId = existing.rows[0]?.id;
    }

    let created = false;
    if (!userId) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, locale, display_name)
         VALUES ($1, NULL, $2, $3) RETURNING id`,
        [profile.email, profile.locale, profile.displayName ?? null],
      );
      userId = inserted.rows[0]?.id;
      created = true;
    }
    if (!userId) throw new Error('user resolution failed inside OAuth link transaction');

    await client.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_account_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_account_id) DO NOTHING`,
      [userId, provider, providerAccountId],
    );

    await client.query('COMMIT');
    return { userId, created };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
