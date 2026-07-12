/**
 * Password hashing — argon2id (trading-security skill: "Passwords: argon2id").
 * Plaintext passwords are never logged, stored, or echoed back; only the hash
 * touches the database.
 */
import argon2 from 'argon2';

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash (shouldn't happen for our own rows) — treat as verification failure,
    // never throw into a code path that could leak timing/detail to the client.
    return false;
  }
}

// A real argon2id hash of an arbitrary fixed value, computed once and cached —
// used purely so "unknown email" and "wrong password" take the same amount of
// time. A *hardcoded* dummy string would fail argon2's parser almost
// instantly instead of running the actual KDF, which defeats the purpose;
// this has to be a hash argon2 itself produced.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash('this-is-never-a-real-password', { type: argon2.argon2id });
  return dummyHash;
}

/**
 * Like verifyPassword, but constant-time with respect to whether `hash` is
 * present at all — call this instead of verifyPassword whenever the caller
 * doesn't already know the user exists (i.e. the login path).
 */
export async function verifyPasswordTimingSafe(
  hash: string | null | undefined,
  plain: string,
): Promise<boolean> {
  if (!hash) {
    await verifyPassword(await getDummyHash(), plain);
    return false;
  }
  return verifyPassword(hash, plain);
}
