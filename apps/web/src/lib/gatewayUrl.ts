/**
 * Server-only helper for building an absolute gateway URL. Used by Server
 * Components that need to call the gateway directly (can't go through
 * next.config.mjs's /api/* rewrite, which only applies to actual incoming
 * browser requests, not server-side fetches issued from within the Next.js
 * process itself). Never imported from a 'use client' file — GATEWAY_ORIGIN
 * has no NEXT_PUBLIC_ prefix on purpose (next.config.mjs's own comment).
 */
export function gatewayUrl(path: string): string {
  const origin = process.env.GATEWAY_ORIGIN ?? 'http://localhost:8080';
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
