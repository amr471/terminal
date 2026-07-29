import type { Metadata } from 'next';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { isLocale, type Locale } from '@terminal/types';
import { t } from '@terminal/i18n';
import { gatewayUrl } from '../../../../../lib/gatewayUrl';
import { BestPricePanel } from '../../../../../components/BestPricePanel';

/**
 * Symbol cross-venue detail view — added 2026-07-18 as the replacement for
 * the persistent Best Price side panel (docs/best-price.md): clicking a
 * Screener row opens this in a new browser tab instead. Deliberately NOT
 * the full terminal shell (no IconRail/CommandBar/TerminalTabs) — this is a
 * simple, single-purpose detail view per John's own framing of the small
 * option ("a similar page opens in a new tab"), not a new saved workspace
 * layout. Reuses terminal-shell.css's generic wrapper classes (already
 * loaded for the whole [locale] segment) for a consistent dark background,
 * and the exact `/auth/me` cookie-forward auth-gating pattern
 * `terminal/page.tsx` uses, since this is still session-gated data.
 */

interface SymbolPageProps {
  params: Promise<{ locale: string; symbol: string }>;
}

export function generateMetadata(): Metadata {
  return { robots: { index: false, follow: false } };
}

interface MeResponse {
  id: string;
  email: string | null;
  locale: Locale;
}

function isMeResponse(value: unknown): value is MeResponse {
  return typeof value === 'object' && value !== null && 'id' in value;
}

export default async function SymbolDetailPage({ params }: SymbolPageProps) {
  const { locale: rawLocale, symbol: rawSymbol } = await params;
  if (!isLocale(rawLocale)) notFound();
  const locale: Locale = rawLocale;
  const symbol = decodeURIComponent(rawSymbol);
  if (!symbol) notFound();

  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get('cookie') ?? '';

  let authorized = false;
  try {
    const meRes = await fetch(gatewayUrl('/auth/me'), { headers: { cookie }, cache: 'no-store' });
    if (meRes.ok) {
      const me: unknown = await meRes.json().catch(() => null);
      authorized = isMeResponse(me);
    }
  } catch {
    authorized = false;
  }
  if (!authorized) redirect(`/${locale}`);

  return (
    <div className="terminal-shell">
      <main className="terminal-shell__main">
        <div className="terminal-shell__command">
          <a href={`/${locale}/terminal`} className="t-symbol-detail__back">
            {t(locale, 'bestprice.symbol_detail.back')}
          </a>
          <h1 className="t-symbol-detail__title">
            {t(locale, 'bestprice.symbol_detail.title', { symbol })}
          </h1>
        </div>
        <div className="terminal-shell__workspace">
          <BestPricePanel locale={locale} symbolFilter={symbol} />
        </div>
      </main>
    </div>
  );
}
