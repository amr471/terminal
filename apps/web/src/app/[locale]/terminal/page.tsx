import type { Metadata } from 'next';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import {
  isLocale,
  defaultLayoutDefinition,
  type Locale,
  type TerminalTabSummary,
} from '@terminal/types';
import { t } from '@terminal/i18n';
import { IconRail } from '@terminal/ui';
import { gatewayUrl } from '../../../lib/gatewayUrl';
import { TerminalCommandBar } from '../../../components/TerminalCommandBar';
import { TerminalTabs } from '../../../components/TerminalTabs';
import { LiveStatusBar } from '../../../components/LiveStatusBar';

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

function isTabsResponse(value: unknown): value is { tabs: TerminalTabSummary[] } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { tabs?: unknown }).tabs)
  );
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

  // A single unsaved local tab if the gateway's unreachable — the shell
  // always needs at least one tab to render. It won't persist server-side
  // until the gateway comes back and the user interacts with it (autosave
  // on the active tab re-establishes a real row via PUT /layouts/tabs/:id,
  // which 404s harmlessly against this placeholder id in the meantime).
  let tabs: TerminalTabSummary[] = [
    {
      id: 'local-fallback',
      title: 'Main',
      order: 0,
      isActive: true,
      definition: defaultLayoutDefinition(),
    },
  ];
  try {
    const tabsRes = await fetch(gatewayUrl('/layouts/tabs'), {
      headers: { cookie },
      cache: 'no-store',
    });
    if (tabsRes.ok) {
      const body: unknown = await tabsRes.json();
      if (isTabsResponse(body) && body.tabs.length > 0) tabs = body.tabs;
    }
  } catch {
    // Gateway unreachable, or malformed response — fall back to the
    // single local tab above rather than failing the whole page (CLAUDE.md:
    // "every third-party feed is assumed unreliable").
  }

  return (
    <div className="terminal-shell">
      <LiveStatusBar locale={locale} initialNowIso={new Date().toISOString()} />
      <div className="terminal-shell__body">
        <IconRail locale={locale} hrefFor={() => `/${locale}/terminal`} />
        <main className="terminal-shell__main">
          <div className="terminal-shell__command">
            <TerminalCommandBar
              locale={locale}
              placeholder={t(locale, 'terminal.command_placeholder')}
            />
          </div>
          <div className="terminal-shell__workspace">
            <TerminalTabs locale={locale} initialTabs={tabs} />
          </div>
        </main>
      </div>
    </div>
  );
}
