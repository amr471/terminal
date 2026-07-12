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

const wsMessageSchema = z.object({
  action: z.enum(['subscribe', 'unsubscribe']),
  channels: z.array(z.string()).min(1).max(50),
});

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

export function registerWsRoute(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const subscriptions = new Map<string, ChannelListener>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      for (const [channel, listener] of subscriptions) {
        void unsubscribeChannel(channel, listener);
      }
      subscriptions.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    async function handleMessage(raw: Buffer): Promise<void> {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw.toString());
      } catch {
        sendJson(socket, { type: 'error', code: 'GW-2008', message: 'Invalid JSON' });
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
