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
