# Gateway REST + WS (P1.2)

Implemented in `services/api-gateway` (Fastify + `@fastify/websocket`).
Builds on P1.1's session model (`/docs/auth.md`) — this doc covers the
browser-facing realtime channel and its supporting REST endpoint.

## Why one WS endpoint

architecture.md §2: "The browser talks to api-gateway only (REST + one
multiplexed WS)." A single `/ws` connection carries every channel a client
subscribes to, rather than one socket per symbol/stream — the browser
multiplexes client-side by `channel` in each frame.

## Auth

Same session cookie as REST (`terminal_session`, httpOnly/Secure/SameSite).
On connect, the gateway resolves the session before accepting any
subscription; an unauthenticated or expired session gets the socket closed
immediately with close code **4001** (`unauthorized`), no data ever sent.
Session resolution is shared code (`sessionAuth.ts`) between REST's
`requireSession` and the WS handler — one place owns "who is this
connection," not two.

## Channel scope — `md.*` only, validated

A client may only subscribe to well-formed `md.*` pub/sub channel names
(architecture.md §4.1: `md.{exchange}.{symbol}.{trades|book|candles.{tf}|funding|oi}`),
checked with `@terminal/types`'s `parseMdChannel`. Anything else — a typo, an
`evt.*` stream, an arbitrary Redis key — gets an `error` frame back, never a
raw Redis `SUBSCRIBE`. `evt.*` streams are internal cross-service buses with
consumer-group/ack semantics; they are not something a browser tab reads
directly.

## Wire protocol

Client → gateway (JSON text frames):

```json
{ "action": "subscribe" | "unsubscribe", "channels": ["md.binance.btcusdt.trades", ...] }
```

Up to 50 channels per message. Gateway → client:

```json
{ "type": "subscribed", "channel": "md.binance.btcusdt.trades" }
{ "type": "unsubscribed", "channel": "md.binance.btcusdt.trades" }
{ "type": "md", "channel": "md.binance.btcusdt.trades", "envelope": { ...Envelope from @terminal/types } }
{ "type": "error", "code": "GW-2008", "channel": "...", "message": "..." }
```

The gateway never reinterprets `envelope` — it's forwarded verbatim from
whatever `market-data` published on that Redis channel (architecture.md
§4.2). No parsing/validation of payload contents happens on the hot path;
that's the publisher's contract, not the gateway's job.

## Fan-out mechanism (`pubsub.ts`)

ioredis rule: a connection that issues `SUBSCRIBE` can only run pub/sub
commands afterward, so the gateway keeps a **dedicated duplicate Redis
connection** for this (`redis.duplicate()`), separate from the shared
command client used for sessions/cache. Subscriptions are **ref-counted**:
the gateway only issues a real `SUBSCRIBE` to Redis on the first browser
connection asking for a channel, and `UNSUBSCRIBE` once the last one leaves
— the dedicated connection's channel set tracks "channels someone is
currently watching," not "channels ever asked for."

Any code path that imports `app.ts` (directly or transitively, e.g. via
`ws.ts`) creates this subscriber connection as an import side effect. Tests
that build the app must call `closeSubscriber()` in their teardown or the
process hangs on a Redis connection retrying forever in an environment with
no Redis (see `app.test.ts` / `ws.test.ts`).

## Backpressure & heartbeat

`md.*` is lossy-tolerant by design (ADR-004 — pub/sub, no persistence,
consumers resync from a snapshot). If a client's outbound buffer
(`socket.bufferedAmount`) exceeds 1MB, further messages to that client are
**dropped**, not queued — one slow browser tab never holds memory hostage
for everyone else's fan-out. The server pings every 30s to detect dead
connections; `ws`'s default pong-timeout handling closes stale sockets.

## REST snapshot endpoint

`GET /md/snapshot/:exchange/:symbol` (session-authenticated) reads
`cache:ticker:{exchange}:{symbol}` and `cache:book:{exchange}:{symbol}` from
Redis and returns both (`null` if absent). Purpose: give a panel real data on
first paint instead of waiting for the next `md.*` tick after subscribing.

**Currently returns `null` for everything** — `market-data`'s live exchange
feeds (P1.5a) haven't landed yet, so nothing populates those cache keys or
publishes on `md.*`. This endpoint and the WS fan-out plumbing are built
ahead of the data on purpose, the same way F0.6 built market-data's
connection-manager skeleton feed-less — P1.2's job is the gateway wiring,
not the feeds.

## Health

`/readyz` now also checks the dedicated pub/sub subscriber connection's
status (`isSubscriberReady()`) alongside Postgres and the main Redis client;
all three must be up for `ready`.

## Testing

- `pubsub.test.ts` — integration tests against real local Redis: a listener
  receives published messages, `unsubscribeChannel` stops delivery, and
  ref-counting keeps a channel alive for a second listener after the first
  unsubscribes.
- `ws.test.ts` — end-to-end against a real listening Fastify server (not
  `app.inject()` — the upgrade handshake needs a real socket) and a real `ws`
  client: unauthenticated connections are closed 4001, a subscribed client
  receives a message published on Redis, and a malformed channel name gets
  an error frame instead of a silent no-op.

Both skip gracefully (not fail) when Postgres/Redis aren't reachable, same
pattern as P1.1's `session.test.ts`/`app.test.ts` — this sandbox has neither
Docker nor sudo, so real execution happens on John's machine or in CI
(`.github/workflows/ci.yml`'s service containers already run every P1.1/P1.2
test on every push/PR).
