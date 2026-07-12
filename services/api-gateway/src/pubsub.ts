/**
 * Redis pub/sub fan-out manager for the browser WS gateway (P1.2,
 * architecture.md §3/§4.1: "R -->|md.* filtered| GW <--> WEB").
 *
 * ioredis rule: once a connection issues SUBSCRIBE it can only run pub/sub
 * commands, so this uses a dedicated `redis.duplicate()` connection rather
 * than the shared command client in redis.ts (which still runs normal
 * GET/SET/session commands).
 *
 * Ref-counted: only issues a real Redis SUBSCRIBE on the first listener for
 * a channel, and UNSUBSCRIBE once the last listener leaves. Keeps the
 * subscriber's channel set equal to "channels at least one connected
 * browser currently cares about," not "channels ever asked for" — this
 * matters once there are thousands of idle WS connections cycling through
 * symbols.
 */
import { redis } from './redis.js';

export type ChannelListener = (message: string) => void;

const listeners = new Map<string, Set<ChannelListener>>();
const subscriber = redis.duplicate();

subscriber.on('error', (err: Error) => {
  console.error('[api-gateway] Redis subscriber error:', err.message);
});

subscriber.on('message', (channel: string, message: string) => {
  const set = listeners.get(channel);
  if (!set) return;
  for (const listener of set) listener(message);
});

export async function subscribeChannel(channel: string, listener: ChannelListener): Promise<void> {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const isFirstListener = set.size === 0;
  set.add(listener);
  if (isFirstListener) await subscriber.subscribe(channel);
}

export async function unsubscribeChannel(
  channel: string,
  listener: ChannelListener,
): Promise<void> {
  const set = listeners.get(channel);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) {
    listeners.delete(channel);
    await subscriber.unsubscribe(channel);
  }
}

/** For /readyz — true once the dedicated subscriber connection is usable. */
export function isSubscriberReady(): boolean {
  return subscriber.status === 'ready';
}

/** Test/shutdown helper — the shared `redis` client's own disconnect() doesn't touch this. */
export function closeSubscriber(): void {
  subscriber.disconnect();
}
