/**
 * Per-account login throttle (P1.1 security follow-up).
 *
 * The flat 10 req/min IP rate limit (`AUTH_RATE_LIMIT` in authRoutes.ts)
 * stops a single attacker hammering from one address, but a distributed
 * attacker (botnet / proxy pool) can spread attempts across many IPs and
 * never trip it while still brute-forcing one victim's password. This closes
 * that gap by counting failures per *email* (not per user id, so behavior is
 * identical whether the email belongs to a real account or not — the login
 * handler's "no such user" vs. "wrong password" ambiguity, GW-2001, and the
 * timing-safe check in password.ts, both rely on that same non-leakage
 * property, and this module preserves it).
 *
 * Threshold and window are deliberately generous (not tuned for UX friction
 * yet) — this is a floor against sustained distributed brute force, not a
 * replacement for MFA/CAPTCHA if that becomes necessary later.
 */
import type { Redis } from 'ioredis';

const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60; // 15 minutes

function throttleKey(email: string): string {
  return `loginfail:${email.trim().toLowerCase()}`;
}

/** Returns true if this email has exceeded the failure threshold and should be locked out. */
export async function isLoginLocked(redis: Redis, email: string): Promise<boolean> {
  const count = await redis.get(throttleKey(email));
  return count !== null && Number(count) >= MAX_FAILURES;
}

/** Records a failed login attempt for this email, starting/extending the window. */
export async function recordLoginFailure(redis: Redis, email: string): Promise<void> {
  const key = throttleKey(email);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
}

/** Clears the failure count on a successful login. */
export async function clearLoginFailures(redis: Redis, email: string): Promise<void> {
  await redis.del(throttleKey(email));
}
