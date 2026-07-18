/**
 * Thin fetch wrappers for the screener's saved-screens REST surface
 * (services/api-gateway/src/screenerRoutes.ts, docs/screener.md) — same
 * same-origin `/api/*` proxy every other apps/web fetch already goes
 * through (next.config.mjs), so the session cookie round-trips the same
 * way SignupForm.tsx's POST does. Deliberately thin: no caching/retry, the
 * caller (ScreenerPanel) decides when to refetch.
 */
import type { ScreenDefinition } from '@terminal/types';

/** Mirrors services/api-gateway/src/screens.ts's `Screen` shape — not
 * imported directly since apps/web has no dependency on that service. */
export interface SavedScreen {
  id: string;
  name: string;
  definition: ScreenDefinition;
  isPreset: boolean;
  sortKey: string | null;
}

export class ScreensApiError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

async function readError(res: Response): Promise<never> {
  let code = 'error.generic';
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    message = body.error?.message;
  } catch {
    // Non-JSON error body (e.g. a proxy 502) — fall back to the generic code.
  }
  throw new ScreensApiError(code, message);
}

export async function listScreens(): Promise<SavedScreen[]> {
  const res = await fetch('/api/screens');
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { screens: SavedScreen[] };
  return body.screens;
}

export async function createScreen(
  name: string,
  definition: ScreenDefinition,
  sortKey?: string,
): Promise<SavedScreen> {
  const res = await fetch('/api/screens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, definition, sortKey }),
  });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { screen: SavedScreen };
  return body.screen;
}

export async function updateScreen(
  id: string,
  patch: { name?: string; definition?: ScreenDefinition; sortKey?: string | null },
): Promise<SavedScreen> {
  const res = await fetch(`/api/screens/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { screen: SavedScreen };
  return body.screen;
}

export async function deleteScreen(id: string): Promise<void> {
  const res = await fetch(`/api/screens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) return readError(res);
}
