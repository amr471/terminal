/**
 * Stable error-code registry (architecture.md §5.7). Codes are load-bearing:
 * logs, UI messages, and docs reference them. Never renumber; only append.
 * Prefixes: MD market-data · GW api-gateway · QT quant · AI ai ·
 * AE alert-engine · TG telegram-bot.
 */

export const ERROR_CODES = {
  // market-data
  'MD-1001': 'Order book sequence gap detected; resyncing from snapshot',
  'MD-1002': 'Feed stale beyond heartbeat threshold',
  'MD-1003': 'Exchange websocket reconnect limit state (DOWN)',
  'MD-1004': 'Malformed upstream message dropped',
  // api-gateway
  'GW-2001': 'Authentication failed',
  'GW-2002': 'Session expired',
  'GW-2003': 'Insufficient subscription tier',
  'GW-2004': 'Rate limit exceeded',
  'GW-2005': 'Invalid screen definition',
  'GW-2006': 'Email already registered',
  'GW-2007': 'OAuth verification failed',
  'GW-2008': 'Invalid request payload',
  'GW-2009': 'Internal error',
  // quant
  'QT-3001': 'Backtest failed',
  'QT-3002': 'Insufficient historical data for range',
  // ai
  'AI-4001': 'LLM provider error',
  'AI-4002': 'BYO key invalid or revoked',
  'AI-4003': 'Strategy spec failed validation',
  // alert-engine
  'AE-5001': 'Alert rule failed validation',
  'AE-5002': 'Rule suppressed: input feed not LIVE',
  // telegram-bot
  'TG-6001': 'Telegram delivery failed',
  'TG-6002': 'Account link not verified',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ServiceError {
  code: ErrorCode;
  /** Human-readable, NEVER contains secrets or key material (CLAUDE.md §9). */
  message: string;
  details?: Record<string, string | number | boolean>;
}

export function isErrorCode(value: string): value is ErrorCode {
  return value in ERROR_CODES;
}
