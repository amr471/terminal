/**
 * End-to-end WS gateway test: a real listening Fastify server (the upgrade
 * handshake needs a real socket, app.inject() doesn't drive it) plus a real
 * `ws` client, authenticated via the same session-cookie flow as the REST
 * tests. Skips gracefully when the local stack isn't up (session.test.ts
 * pattern).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { closeSubscriber } from './pubsub.js';

async function servicesReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const reachable = await servicesReachable();
if (!reachable) {
  console.warn('[ws.test.ts] local Postgres/Redis not reachable — skipping.');
}

interface WsFrame {
  type: string;
  channel?: string;
  code?: string;
  envelope?: unknown;
}

function isWsFrame(value: unknown): value is WsFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, 'expected a Set-Cookie header');
  const value = raw.split(';')[0];
  assert.ok(value);
  return value;
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function signupAndGetCookie(app: App): Promise<string> {
  const email = `ws-test-${randomUUID()}@example.invalid`;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'a-reasonably-long-password' },
  });
  assert.equal(res.statusCode, 201);
  return extractSessionCookie(res.headers['set-cookie']);
}

async function listenOnRandomPort(app: App): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo | null;
  assert.ok(address && typeof address === 'object', 'expected a bound TCP address');
  return address.port;
}

function waitForFrame(
  ws: WebSocket,
  predicate: (frame: WsFrame) => boolean,
  timeoutMs = 2000,
): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS frame')), timeoutMs);
    ws.on('message', (raw: Buffer) => {
      const parsed: unknown = JSON.parse(raw.toString());
      if (isWsFrame(parsed) && predicate(parsed)) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });
}

test(
  'WS connection without a session cookie is closed as unauthorized',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const port = await listenOnRandomPort(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
    });
    assert.equal(closeCode, 4001);

    await app.close();
  },
);

test(
  'WS subscribe -> Redis publish -> client receives the envelope',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signupAndGetCookie(app);
    const port = await listenOnRandomPort(app);

    const channel = `md.binance.wstest${randomUUID().slice(0, 8)}.trades`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({ action: 'subscribe', channels: [channel] }));
    await waitForFrame(ws, (f) => f.type === 'subscribed' && f.channel === channel);

    const envelope = {
      v: 1,
      type: 'trade',
      src: 'binance',
      sym: 'wstest',
      ts: Date.now(),
      rts: Date.now(),
      seq: 1,
      data: { price: '64000.00', qty: '0.01', side: 'buy' },
    };
    await redis.publish(channel, JSON.stringify(envelope));

    const received = await waitForFrame(ws, (f) => f.type === 'md' && f.channel === channel);
    assert.deepEqual(received.envelope, envelope);

    ws.close();
    await app.close();
  },
);

test('WS rejects an unknown/malformed channel name', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signupAndGetCookie(app);
  const port = await listenOnRandomPort(app);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  ws.send(JSON.stringify({ action: 'subscribe', channels: ['not.a.valid.channel'] }));
  const errFrame = await waitForFrame(ws, (f) => f.type === 'error');
  assert.equal(errFrame.code, 'GW-2008');

  ws.close();
  await app.close();
});

test(
  'WS screener.subscribe returns an initial snapshot; unsubscribe is acked',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signupAndGetCookie(app);
    const port = await listenOnRandomPort(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Inline definition (works even with an empty instrument_state — the
    // snapshot just carries zero rows). subId is echoed back on every frame.
    ws.send(
      JSON.stringify({
        action: 'screener.subscribe',
        subId: 'sub-a',
        definition: {
          version: 1,
          root: {
            kind: 'group',
            logic: 'and',
            children: [{ kind: 'numeric', field: 'volume_24h', op: 'gt', value: '0' }],
          },
        },
      }),
    );
    const snap = await waitForFrame(
      ws,
      (f) => f.type === 'screener.snapshot' && (f as { subId?: string }).subId === 'sub-a',
    );
    assert.ok(Array.isArray((snap as { rows?: unknown }).rows));

    ws.send(JSON.stringify({ action: 'screener.unsubscribe', subId: 'sub-a' }));
    await waitForFrame(
      ws,
      (f) => f.type === 'screener.unsubscribed' && (f as { subId?: string }).subId === 'sub-a',
    );

    ws.close();
    await app.close();
  },
);

test(
  'WS screener.subscribe with an invalid definition returns GW-2005',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signupAndGetCookie(app);
    const port = await listenOnRandomPort(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.send(
      JSON.stringify({
        action: 'screener.subscribe',
        subId: 'bad',
        definition: { version: 99, root: {} },
      }),
    );
    const err = await waitForFrame(ws, (f) => f.type === 'error');
    assert.equal(err.code, 'GW-2005');

    ws.close();
    await app.close();
  },
);

test(
  'WS bestprice.subscribe returns an initial snapshot; unsubscribe is acked',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signupAndGetCookie(app);
    const port = await listenOnRandomPort(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // No definition/filter to pass (unlike screener) — the snapshot just
    // carries whatever bestPriceHub currently has (zero rows against an
    // empty instrument_state is fine).
    ws.send(JSON.stringify({ action: 'bestprice.subscribe', subId: 'sub-a' }));
    const snap = await waitForFrame(
      ws,
      (f) => f.type === 'bestprice.snapshot' && (f as { subId?: string }).subId === 'sub-a',
    );
    assert.ok(Array.isArray((snap as { rows?: unknown }).rows));

    ws.send(JSON.stringify({ action: 'bestprice.unsubscribe', subId: 'sub-a' }));
    await waitForFrame(
      ws,
      (f) => f.type === 'bestprice.unsubscribed' && (f as { subId?: string }).subId === 'sub-a',
    );

    ws.close();
    await app.close();
  },
);

test('WS bestprice.subscribe with a malformed message returns GW-2008', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signupAndGetCookie(app);
  const port = await listenOnRandomPort(app);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  ws.send(JSON.stringify({ action: 'bestprice.subscribe' })); // missing subId
  const err = await waitForFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'GW-2008');

  ws.close();
  await app.close();
});

after(async () => {
  if (reachable) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'ws-test-%@example.invalid'`);
  }
  await pool.end().catch(() => undefined);
  // See app.test.ts: buildApp() opens its own dedicated pub/sub subscriber
  // connection independent of the shared `redis` client — close it explicitly.
  closeSubscriber();
  redis.disconnect();
});
