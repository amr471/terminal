/**
 * `/` has no content of its own — redirect to the negotiated locale
 * (`/en` or `/ru`) so every real page lives under `[locale]` (CLAUDE.md §8:
 * i18n from the first commit, not bolted on later). Scoped to exactly `/`
 * via the matcher below so it never touches `/api/*` (proxied to the
 * gateway by next.config.mjs) or the locale routes themselves.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { negotiateLocale } from '@terminal/i18n';

export function middleware(request: NextRequest): NextResponse {
  const locale = negotiateLocale(request.headers.get('accept-language') ?? undefined);
  return NextResponse.redirect(new URL(`/${locale}`, request.url));
}

export const config = {
  matcher: ['/'],
};
