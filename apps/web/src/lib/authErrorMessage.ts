/**
 * Maps a GW-* error code from the gateway (@terminal/types ERROR_CODES) to
 * the catalog key that has copy actually written for it. Codes without
 * dedicated landing-page copy fall back to the generic error — never show
 * an untranslated code to a trader signing up.
 */
import type { MessageKey } from '@terminal/i18n';

const KNOWN_ERROR_KEYS: readonly MessageKey[] = ['error.GW-2001', 'error.GW-2004', 'error.GW-2006'];

export function authErrorMessageKey(code: string | undefined): MessageKey {
  const key = `error.${code}`;
  const match = (KNOWN_ERROR_KEYS as readonly string[]).find((k) => k === key);
  return (match as MessageKey | undefined) ?? 'error.generic';
}
