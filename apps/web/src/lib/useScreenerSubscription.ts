/**
 * React hook wiring gatewaySocket.ts + screenerReducer.ts together: given a
 * live target (an inline definition or a saved screen/preset id), keeps a
 * screener.subscribe alive for the component's lifetime and exposes the
 * current row order plus a coarse connection status. Re-using the same
 * `subId` across a definition edit replaces the subscription in place
 * (docs/screener.md) rather than needing a separate unsubscribe/resubscribe
 * dance client-side.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ScreenDefinition, ScreenerRow, ScreenerServerFrame } from '@terminal/types';
import { getGatewaySocket, type GatewaySocketStatus } from './gatewaySocket.js';
import {
  applyScreenerFrame,
  screenerStateRows,
  EMPTY_SCREENER_STATE,
  type ScreenerTableState,
} from './screenerReducer.js';

export type ScreenerSubscriptionTarget = { definition: ScreenDefinition } | { screenId: string };

export type ScreenerLiveStatus = 'connecting' | 'live' | 'error';

export interface ScreenerSubscriptionResult {
  rows: ScreenerRow[];
  status: ScreenerLiveStatus;
  errorMessage?: string;
}

let subIdCounter = 0;

function reduceFrame(state: ScreenerTableState, frame: ScreenerServerFrame): ScreenerTableState {
  if (frame.type === 'screener.snapshot' || frame.type === 'screener.delta') {
    return applyScreenerFrame(state, frame);
  }
  return state; // 'screener.unsubscribed' / 'error' don't touch row state
}

export function useScreenerSubscription(
  target: ScreenerSubscriptionTarget | null,
): ScreenerSubscriptionResult {
  const subIdRef = useRef<string | null>(null);
  if (subIdRef.current === null) {
    subIdCounter += 1;
    subIdRef.current = `screener-${subIdCounter}`;
  }
  const subId = subIdRef.current;

  const [state, dispatch] = useReducer(reduceFrame, EMPTY_SCREENER_STATE);
  const [socketStatus, setSocketStatus] = useState<GatewaySocketStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  // A fresh object identity every render shouldn't re-subscribe — only a
  // logical change (a different definition/screenId) should.
  const targetKey = target ? JSON.stringify(target) : null;

  useEffect(() => {
    if (!target) return;
    const socket = getGatewaySocket();
    setSocketStatus(socket.getStatus());
    const unsubscribeStatus = socket.onStatusChange(setSocketStatus);

    const message =
      'definition' in target
        ? { action: 'screener.subscribe' as const, subId, definition: target.definition }
        : { action: 'screener.subscribe' as const, subId, screenId: target.screenId };

    const unsubscribe = socket.subscribeScreener(subId, message, (frame) => {
      if (frame.type === 'error') {
        setErrorMessage(frame.message ?? frame.code);
        return;
      }
      setErrorMessage(undefined);
      dispatch(frame);
    });

    return () => {
      unsubscribe();
      unsubscribeStatus();
    };
    // targetKey is the real dependency (a stable fingerprint of `target`); the object itself is intentionally excluded.
  }, [targetKey, subId]);

  const status: ScreenerLiveStatus = errorMessage
    ? 'error'
    : socketStatus === 'open'
      ? 'live'
      : 'connecting';
  const result: ScreenerSubscriptionResult = { rows: screenerStateRows(state), status };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  return result;
}
