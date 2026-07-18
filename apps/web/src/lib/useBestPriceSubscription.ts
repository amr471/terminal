/**
 * React hook wiring gatewaySocket.ts + bestPriceReducer.ts together (P1.7b),
 * mirroring useScreenerSubscription.ts. Simpler than the screener hook:
 * there's no target/definition to pass or compare — every consumer of the
 * consolidated best-price board gets the same live rows, so the hook takes
 * no arguments and just holds one subscription open for its own lifetime.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { BestPriceRow, BestPriceServerFrame } from '@terminal/types';
import { getGatewaySocket, type GatewaySocketStatus } from './gatewaySocket.js';
import {
  applyBestPriceFrame,
  bestPriceStateRows,
  EMPTY_BEST_PRICE_STATE,
  type BestPriceTableState,
} from './bestPriceReducer.js';

export type BestPriceLiveStatus = 'connecting' | 'live' | 'error';

export interface BestPriceSubscriptionResult {
  rows: BestPriceRow[];
  status: BestPriceLiveStatus;
  errorMessage?: string;
}

let subIdCounter = 0;

function reduceFrame(
  state: BestPriceTableState,
  frame: BestPriceServerFrame,
): BestPriceTableState {
  if (frame.type === 'bestprice.snapshot' || frame.type === 'bestprice.delta') {
    return applyBestPriceFrame(state, frame);
  }
  return state; // 'bestprice.unsubscribed' / 'error' don't touch row state
}

export function useBestPriceSubscription(): BestPriceSubscriptionResult {
  const subIdRef = useRef<string | null>(null);
  if (subIdRef.current === null) {
    subIdCounter += 1;
    subIdRef.current = `bestprice-${subIdCounter}`;
  }
  const subId = subIdRef.current;

  const [state, dispatch] = useReducer(reduceFrame, EMPTY_BEST_PRICE_STATE);
  const [socketStatus, setSocketStatus] = useState<GatewaySocketStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    const socket = getGatewaySocket();
    setSocketStatus(socket.getStatus());
    const unsubscribeStatus = socket.onStatusChange(setSocketStatus);

    const unsubscribe = socket.subscribeBestPrice(subId, (frame) => {
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
  }, [subId]);

  const status: BestPriceLiveStatus = errorMessage
    ? 'error'
    : socketStatus === 'open'
      ? 'live'
      : 'connecting';
  const result: BestPriceSubscriptionResult = { rows: bestPriceStateRows(state), status };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  return result;
}
