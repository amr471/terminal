/**
 * Browser WebSocket gateway (P1.2, architecture.md §2: "The browser talks to
 * api-gateway only (REST + one multiplexed WS)"). Clients authenticate with
 * the same session cookie as REST, then subscribe/unsubscribe to `md.*`
 * channels by name; the gateway fans out whatever market-data publishes
 * verbatim — the envelope shape is owned by @terminal/types, the gateway
 * never reinterprets it (prime directive: no LLM, and no gateway logic
 * either, sits on the hot numeric path).
 *
 * Deliberately narrow: a client can only ever subscribe to well-formed
 * `md.*` channel names (validated with `parseMdChannel`) — never arbitrary
 * Redis channels, and never the internal `evt.*` streams directly. Those are
 * cross-service buses with their own consumer-group semantics (architecture.md
 * §4.1), not something a browser tab subscribes to raw.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { parseMdChannel } from '@terminal/types';
import { resolveSession } from './sessionAuth.js';
import { subscribeChannel, unsubscribeChannel, type ChannelListener } from './pubsub.js';
import { screenerHub } from './screenerHub.js';
import { bestPriceHub } from './bestPriceHub.js';
import { validateScreenDefinition } from './screenerValidation.js';
import { getDefinition } from './screens.js';
import { pool } from './db.js';

const wsMessageSchema = z.object({
  action: z.enum(['subscribe', 'unsubscribe']),
  channels: z.array(z.string()).min(1).max(50),
});

// Screener live subscriptions (P1.6) ride the same WS as md.*: the client picks
// a subId, sends an inline definition or a saved-screen/preset id, and gets an
// initial `screener.snapshot` then `screener.delta` frames as the working set
// changes (ScreenerHub owns the diffing). subId is client-scoped (echoed back).
const screenerSubSchema = z.object({
  action: z.literal('screener.subscribe'),
  subId: z.string().min(1).max(64),
  definition: z.unknown().optional(),
  screenId: z.string().optional(),
});
const screenerUnsubSchema = z.object({
  action: z.literal('screener.unsubscribe'),
  subId: z.string().min(1).max(64),
});
const MAX_SCREENER_SUBS = 10;

// Consolidated best-price live subscriptions (P1.7b) ride the same WS,
// mirroring screener.subscribe's shape — but there's no filter/definition to
// pass (bestPriceHub.ts: every subscriber sees the same consolidated rows),
// so the message carries nothing beyond subId.
const bestPriceSubSchema = z.object({
  action: z.literal('bestprice.subscribe'),
  subId: z.string().min(1).max(64),
});
const bestPriceUnsubSchema = z.object({
  action: z.literal('bestprice.unsubscribe'),
  subId: z.string().min(1).max(64),
});
const MAX_BESTPRICE_SUBS = 10;

// md.* is lossy-tolerant by design (ADR-004: pub/sub, no persistence, resync
// from a snapshot). A client that isn't draining fast enough gets messages
// dropped rather than buffered without bound — never let one slow browser
// tab hold memory hostage for everyone else's fan-out.
const MAX_BUFFERED_BYTES = 1_000_000;
const HEARTBEAT_MS = 30_000;

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
  socket.send(JSON.stringify(payload));
}

function safeParseEnvelope(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerWsRoute(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const subscriptions = new Map<string, ChannelListener>();
    const screenerSubs = new Map<string, () => void>(); // client subId -> hub unsubscribe
    const bestPriceSubs = new Map<string, () => void>(); // client subId -> hub unsubscribe
    let sessionUserId = '';
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      for (const [channel, listener] of subscriptions) {
        void unsubscribeChannel(channel, listener);
      }
      subscriptions.clear();
      for (const unsub of screenerSubs.values()) unsub();
      screenerSubs.clear();
      for (const unsub of bestPriceSubs.values()) unsub();
      bestPriceSubs.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    async function handleScreener(parsedBody: unknown): Promise<void> {
      const sub = screenerSubSchema.safeParse(parsedBody);
      if (sub.success) {
        const { subId } = sub.data;
        if (!screenerSubs.has(subId) && screenerSubs.size >= MAX_SCREENER_SUBS) {
          sendJson(socket, { type: 'error', code: 'GW-2008', subId, message: 'Too many screener subscriptions' });
          return;
        }
        let definition;
        if (typeof sub.data.screenId === 'string') {
          const def = await getDefinition(pool, sessionUserId, sub.data.screenId);
          if (!def) {
            sendJson(socket, { type: 'error', code: 'GW-2012', subId, message: 'Screen not found' });
            return;
          }
          definition = def;
        } else {
          const check = validateScreenDefinition(sub.data.definition);
          if (!check.ok) {
            sendJson(socket, { type: 'error', code: 'GW-2005', subId, message: check.detail });
            return;
          }
          definition = check.definition;
        }
        screenerSubs.get(subId)?.(); // replace an existing sub with the same id
        const send = (payload: Record<string, unknown>): void => sendJson(socket, { ...payload, subId });
        screenerSubs.set(subId, screenerHub.subscribe(definition, send));
        return;
      }
      const unsub = screenerUnsubSchema.safeParse(parsedBody);
      if (unsub.success) {
        screenerSubs.get(unsub.data.subId)?.();
        screenerSubs.delete(unsub.data.subId);
        sendJson(socket, { type: 'screener.unsubscribed', subId: unsub.data.subId });
        return;
      }
      sendJson(socket, { type: 'error', code: 'GW-2008', message: 'Invalid message shape' });
    }

    function handleBestPrice(parsedBody: unknown): void {
      const sub = bestPriceSubSchema.safeParse(parsedBody);
      if (sub.success) {
        const { subId } = sub.data;
        if (!bestPriceSubs.has(subId) && bestPriceSubs.size >= MAX_BESTPRICE_SUBS) {
          sendJson(socket, { type: 'error', code: 'GW-2008', subId, message: 'Too many best-price subscriptions' });
          return;
        }
        bestPriceSubs.get(subId)?.(); // replace an existing sub with the same id
        const send = (payload: Record<string, unknown>): void => sendJson(socket, { ...payload, subId });
        bestPriceSubs.set(subId, bestPriceHub.subscribe(send));
        return;
      }
      const unsub = bestPriceUnsubSchema.safeParse(parsedBody);
      if (unsub.success) {
        bestPriceSubs.get(unsub.data.subId)?.();
        bestPriceSubs.delete(unsub.data.subId);
        sendJson(socket, { type: 'bestprice.unsubscribed', subId: unsub.data.subId });
        return;
      }
      sendJson(socket, { type: 'error', code: 'GW-2008', message: 'Invalid message shape' });
    }

    async function handleMessage(raw: Buffer): Promise<void> {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw.toString());
      } catch {
        sendJson(socket, { type: 'error', code: 'GW-2008', message: 'Invalid JSON' });
        return;
      }

      if (isPlainObject(parsedBody) && typeof parsedBody.action === 'string' && parsedBody.action.startsWith('screener.')) {
        await handleScreener(parsedBody);
        return;
      }

      if (isPlainObject(parsedBody) && typeof parsedBody.action === 'string' && parsedBody.action.startsWith('bestprice.')) {
        handleBestPrice(parsedBody);
        return;
      }

      const result = wsMessageSchema.safeParse(parsedBody);
      if (!result.success) {
        sendJson(socket, { type: 'error', code: 'GW-2008', message: 'Invalid message shape' });
        return;
      }
      const { action, channels } = result.data;

      for (const channel of channels) {
        if (!parseMdChannel(channel)) {
          sendJson(socket, {
            type: 'error',
            code: 'GW-2008',
            channel,
            message: 'Unknown or malformed channel',
          });
          continue;
        }

        if (action === 'subscribe') {
          if (subscriptions.has(channel)) {
            sendJson(socket, { type: 'subscribed', channel });
            continue;
          }
          const listener: ChannelListener = (message) => {
            sendJson(socket, { type: 'md', channel, envelope: safeParseEnvelope(message) });
          };
          subscriptions.set(channel, listener);
          await subscribeChannel(channel, listener);
          sendJson(socket, { type: 'subscribed', channel });
        } else {
          const listener = subscriptions.get(channel);
          if (listener) {
            subscriptions.delete(channel);
            await unsubscribeChannel(channel, listener);
          }
          sendJson(socket, { type: 'unsubscribed', channel });
        }
      }
    }

    // Auth is async (a DB round trip via resolveSession), but a client can send
    // its first `subscribe` frame the instant it sees `open` — before that
    // promise settles. `ws` does not queue 'message' events for a socket with
    // no listener attached yet; it drops them. So the listener goes on
    // synchronously, right now, and queues anything that arrives pre-auth
    // rather than processing it inline. Found via a real WS test run against
    // live Redis (sandbox skip-tests never exercise this race).
    const preAuthQueue: Buffer[] = [];
    let authorized = false;

    socket.on('message', (raw: Buffer) => {
      if (!authorized) {
        preAuthQueue.push(raw);
        return;
      }
      void handleMessage(raw);
    });

    void (async () => {
      const session = await resolveSession(request);
      if (!session) {
        socket.close(4001, 'unauthorized');
        return;
      }
      sessionUserId = session.userId;
      authorized = true;

      heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, HEARTBEAT_MS);

      const queued = preAuthQueue.splice(0, preAuthQueue.length);
      for (const raw of queued) {
        await handleMessage(raw);
      }
    })();
  });
}
