import type { Metadata } from 'next';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { isLocale, isValidLayoutDefinition, defaultLayoutDefinition, type Locale } from '@terminal/types';
import { t } from '@terminal/i18n';
import { IconRail, StatusBar } from '@terminal/ui';
import { gatewayUrl } from '../../../lib/gatewayUrl';
import { TerminalCommandBar } from '../../../components/TerminalCommandBar';
import { TerminalWorkspace } from '../../../components/TerminalWorkspace';

interface TerminalPageProps {
  params: Promise<{ locale: string }>;
}

/** Session-gated — never worth indexing. */
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

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  // Server Components can't read the browser's cookie jar directly — forward
  // whatever Cookie header the browser sent us verbatim to the gateway,
  // which does its own signature verification (services/api-gateway/src/
  // sessionAuth.ts). `cache: 'no-store'` on both fetches below: this is
  // per-user data keyed by that cookie, and Next's default fetch caching in
  // Server Components would otherwise risk serving one user's session data
  // to the next request for the same URL.
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get('cookie') ?? '';

  // Wrapped in try/catch (not just checking meRes.ok): fetch() itself throws
  // on a connection failure, not just on a non-2xx response — an
  // unreachable gateway must degrade to "not authenticated", never crash
  // the page with an unhandled rejection. redirect() is called after this
  // block, never inside it, so it can't be accidentally swallowed by the
  // catch (Next's redirect() works by throwing a control-flow signal).
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

  let initialDefinition = defaultLayoutDefinition();
  try {
    const layoutRes = await fetch(gatewayUrl('/layouts/default'), { headers: { cookie }, cache: 'no-store' });
    if (layoutRes.ok) {
      const body: unknown = await layoutRes.json();
      const candidate =
        typeof body === 'object' && body !== null && 'definition' in body
          ? (body as { definition: unknown }).definition
          : null;
      if (isValidLayoutDefinition(candidate)) initialDefinition = candidate;
    }
  } catch {
    // Gateway unreachable, or malformed response — fall back to the
    // hardcoded default rather than failing the whole page (CLAUDE.md:
    // "every third-party feed is assumed unreliable").
  }

  return (
    <div className="terminal-shell">
      <StatusBar locale={locale} />
      <div className="terminal-shell__body">
        <IconRail locale={locale} hrefFor={() => `/${locale}/terminal`} />
        <main className="terminal-shell__main">
          <div className="terminal-shell__command">
            <TerminalCommandBar locale={locale} placeholder={t(locale, 'terminal.command_placeholder')} />
          </div>
          <div className="terminal-shell__workspace">
            <TerminalWorkspace locale={locale} initialDefinition={initialDefinition} />
          </div>
        </main>
      </div>
    </div>
  );
}
