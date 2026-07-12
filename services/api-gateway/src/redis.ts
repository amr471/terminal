/**
 * Redis client for api-gateway: `sess:{sessionId}` cache-aside (architecture.md
 * §4.1) and `evt.audit` stream writes. Postgres is the source of truth for
 * sessions; Redis only accelerates lookups and is safe to lose/flush.
 */
import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, {
  // Fail fast in health checks rather than buffering commands indefinitely
  // against a down Redis (CLAUDE.md — every feed/dependency assumed unreliable).
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('[api-gateway] Redis client error:', err.message);
});

export function sessionCacheKey(sessionId: string): string {
  return `sess:${sessionId}`;
}
