/**
 * The app's first browser WebSocket client (P1.7 UI) — connects to the
 * gateway's single multiplexed `/ws` endpoint (architecture.md §2,
 * docs/gateway-ws.md) through the same same-origin `/api/*` rewrite REST
 * already uses (next.config.mjs), so the Secure session cookie round-trips
 * exactly the way it does for `fetch()` — a direct cross-origin connection
 * to GATEWAY_ORIGIN would not carry that cookie (docs/landing-page.md's
 * whole reason for the rewrite in the first place).
 *
 * Originally scoped to screener.* subscriptions only ("md.* multiplexing
 * ... isn't built until a consumer needs it"). P1.7b's best-price board is
 * that next consumer, so the subscription machinery generalized here: any
 * feature with its own `{subId, ...}`-shaped subscribe/unsubscribe messages
 * and a runtime frame guard can ride the same socket via `subscribe()` —
 * screener.ts's frames and bestPrice.ts's frames are just two instances of
 * that shape today. `subscribeScreener()` is kept as a thin wrapper so
 * existing callers (useScreenerSubscription.ts) don't need to change.
 *
 * One socket per browser tab (module-level singleton via getGatewaySocket()):
 * every subscriber across every feature shares it and is multiplexed by
 * `subId` (docs/gateway-ws.md). Reconnects with capped exponential backoff
 * and transparently re-sends every active subscription on reconnect — a
 * dropped connection is invisible above this module (the hook layer only
 * sees `onStatusChange`).
 */
import {
  isScreenerServerFrame,
  isBestPriceServerFrame,
  type ScreenerServerFrame,
  type ScreenerSubscribeMessage,
  type BestPriceServerFrame,
  type BestPriceSubscribeMessage,
} from '@terminal/types';

export type GatewaySocketStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Capped exponential backoff, no jitter (single-tab reconnect — thundering
 * herd across many tabs from one user isn't the failure mode this guards
 * against; a shared gateway restart affecting many *users* at once would be,
 * and is a fair follow-up if it becomes a real problem). */
export function backoffDelayMs(
  attempt: number,
  baseMs = RECONNECT_BASE_MS,
  maxMs = RECONNECT_MAX_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}

/** Same-origin `/api/ws` — proxied to the gateway's `/ws` by next.config.mjs's
 * existing rewrite, protocol-matched to the page (wss: under https:). */
export function gatewayWsUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/api/ws`;
}

interface Sub {
  message: unknown;
  isFrame: (value: unknown) => boolean;
  onFrame: (frame: unknown) => void;
}

function isSubIdFrame(value: unknown): value is { subId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { subId?: unknown }).subId === 'string'
  );
}

export class GatewaySocket {
  private ws: WebSocket | null = null;
  private status: GatewaySocketStatus = 'closed';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly subs = new Map<string, Sub>();
  private readonly statusListeners = new Set<(status: GatewaySocketStatus) => void>();

  getStatus(): GatewaySocketStatus {
    return this.status;
  }

  onStatusChange(listener: (status: GatewaySocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(status: GatewaySocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  connect(): void {
    if (this.destroyed || this.ws) return;
    this.setStatus('connecting');
    const ws = new WebSocket(gatewayWsUrl(window.location));
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('open');
      // Transparent to callers: a reconnect just re-runs every subscription
      // currently registered, across every feature sharing this socket.
      for (const sub of this.subs.values()) this.send(sub.message);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // never trust the wire — a malformed frame is just dropped
      }
      if (!isSubIdFrame(parsed)) return; // a subId-less error frame has no subscriber to route to
      const sub = this.subs.get(parsed.subId);
      if (sub && sub.isFrame(parsed)) sub.onFrame(parsed);
    });

    const onDown = (): void => {
      if (this.ws !== ws) return; // a stale event from an already-replaced socket
      this.ws = null;
      if (this.destroyed) {
        this.setStatus('closed');
        return;
      }
      this.setStatus('connecting');
      const delay = backoffDelayMs(this.attempt);
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', onDown);
  }

  /** Subscribes (or, re-using an existing `subId`, replaces a subscription)
   * and connects the socket if this is the first subscriber. `unsubscribeMessage`
   * is sent both on explicit unsubscribe and is otherwise unused (a reconnect
   * re-sends `message`, never `unsubscribeMessage`). Returns an unsubscribe
   * function. Generic over any feature's own frame shape — `isFrame` narrows
   * incoming messages before they're handed to `onFrame`. */
  subscribe<TFrame>(
    subId: string,
    message: unknown,
    unsubscribeMessage: unknown,
    isFrame: (value: unknown) => value is TFrame,
    onFrame: (frame: TFrame) => void,
  ): () => void {
    this.subs.set(subId, {
      message,
      isFrame: isFrame as (value: unknown) => boolean,
      onFrame: onFrame as (frame: unknown) => void,
    });
    this.connect();
    this.send(message);
    return () => {
      this.subs.delete(subId);
      this.send(unsubscribeMessage);
    };
  }

  /** Thin wrapper over `subscribe()` for screener.* messages — kept so
   * useScreenerSubscription.ts (P1.7 UI) didn't need to change when this
   * socket generalized for P1.7b. */
  subscribeScreener(
    subId: string,
    message: ScreenerSubscribeMessage,
    onFrame: (frame: ScreenerServerFrame) => void,
  ): () => void {
    return this.subscribe(
      subId,
      message,
      { action: 'screener.unsubscribe', subId },
      isScreenerServerFrame,
      onFrame,
    );
  }

  /** Same shape for bestprice.* messages (P1.7b) — no filter/definition to
   * pass, every subscriber sees the same consolidated rows (bestPrice.ts). */
  subscribeBestPrice(
    subId: string,
    onFrame: (frame: BestPriceServerFrame) => void,
  ): () => void {
    const message: BestPriceSubscribeMessage = { action: 'bestprice.subscribe', subId };
    return this.subscribe(
      subId,
      message,
      { action: 'bestprice.unsubscribe', subId },
      isBestPriceServerFrame,
      onFrame,
    );
  }

  /** Test/teardown escape hatch — never called from app code (the socket is
   * a per-tab singleton meant to outlive any one component). */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.subs.clear();
    this.statusListeners.clear();
  }
}

let singleton: GatewaySocket | null = null;

/** One socket per browser tab, lazily created on first subscriber. */
export function getGatewaySocket(): GatewaySocket {
  singleton ??= new GatewaySocket();
  return singleton;
}
