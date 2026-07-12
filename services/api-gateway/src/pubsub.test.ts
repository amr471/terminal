/**
 * Integration tests against the real local Redis (P1.0's docker-compose).
 * Skips gracefully — rather than failing the whole suite — when the local
 * stack isn't reachable (same pattern as session.test.ts).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import {
  subscribeChannel,
  unsubscribeChannel,
  isSubscriberReady,
  closeSubscriber,
} from './pubsub.js';

async function redisReachable(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const reachable = await redisReachable();
if (!reachable) {
  console.warn(
    '[pubsub.test.ts] local Redis not reachable — skipping integration tests. ' +
      'Run `pnpm dev:up` to enable them.',
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testChannel(tag: string): string {
  return `md.binance.${tag}${randomUUID().slice(0, 8)}.trades`;
}

test(
  'isSubscriberReady reflects the dedicated subscriber connection',
  { skip: !reachable },
  async () => {
    for (let i = 0; i < 20 && !isSubscriberReady(); i++) await wait(50);
    assert.equal(isSubscriberReady(), true);
  },
);

test(
  'subscribeChannel delivers published messages to the listener',
  { skip: !reachable },
  async () => {
    const channel = testChannel('sub');
    const received: string[] = [];
    const listener = (message: string): void => {
      received.push(message);
    };

    await subscribeChannel(channel, listener);
    await wait(50); // let the SUBSCRIBE round-trip land before publishing
    await redis.publish(channel, 'hello');
    await wait(150);

    assert.deepEqual(received, ['hello']);
    await unsubscribeChannel(channel, listener);
  },
);

test('unsubscribeChannel stops delivery', { skip: !reachable }, async () => {
  const channel = testChannel('unsub');
  const received: string[] = [];
  const listener = (message: string): void => {
    received.push(message);
  };

  await subscribeChannel(channel, listener);
  await wait(50);
  await unsubscribeChannel(channel, listener);
  await wait(50);
  await redis.publish(channel, 'should-not-arrive');
  await wait(150);

  assert.deepEqual(received, []);
});

test(
  'ref-counting: removing one of two listeners keeps the channel alive for the other',
  { skip: !reachable },
  async () => {
    const channel = testChannel('ref');
    const a: string[] = [];
    const b: string[] = [];
    const listenerA = (m: string): void => {
      a.push(m);
    };
    const listenerB = (m: string): void => {
      b.push(m);
    };

    await subscribeChannel(channel, listenerA);
    await subscribeChannel(channel, listenerB);
    await wait(50);
    await unsubscribeChannel(channel, listenerA);
    await wait(50);
    await redis.publish(channel, 'still-here');
    await wait(150);

    assert.deepEqual(a, []);
    assert.deepEqual(b, ['still-here']);
    await unsubscribeChannel(channel, listenerB);
  },
);

after(() => {
  closeSubscriber();
  redis.disconnect();
});
