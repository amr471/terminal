/**
 * Telegram Login Widget verification (https://core.telegram.org/widgets/login).
 * Pure function, no network call — the widget itself talks to Telegram; the
 * gateway only checks the signature Telegram attached to the payload.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramLoginPayload {
  id: number;
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
  photo_url?: string | undefined;
  auth_date: number;
  hash: string;
}

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60; // 1 day — payload becomes stale after this

export function isTelegramLoginPayload(value: unknown): value is TelegramLoginPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'number' &&
    typeof v['first_name'] === 'string' &&
    typeof v['auth_date'] === 'number' &&
    typeof v['hash'] === 'string'
  );
}

/** Returns true iff the payload's hash matches what Telegram would have signed with botToken. */
export function verifyTelegramLogin(payload: TelegramLoginPayload, botToken: string): boolean {
  const { hash, ...fields } = payload;

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${String(fields[key as keyof typeof fields])}`)
    .join('\n');

  const secretKey = createHash('sha256').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const ageSeconds = Date.now() / 1000 - payload.auth_date;
  if (ageSeconds < 0 || ageSeconds > MAX_AUTH_AGE_SECONDS) return false;

  return true;
}
