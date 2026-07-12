import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@terminal/types';
import { t } from '@terminal/i18n';
import '@terminal/ui/tokens.css';
import '@terminal/ui/terminal.css';
import './landing.css';
import './terminal/terminal-shell.css';

interface LocaleLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

/** Only `/en` and `/ru` are real routes — anything else 404s rather than
 * silently rendering as English (that would create duplicate-content pages
 * for search engines). */
export function generateStaticParams(): { locale: Locale }[] {
  return [{ locale: 'en' }, { locale: 'ru' }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) return {};
  const title = `${t(raw, 'app.name')} — ${t(raw, 'app.tagline')}`;
  const description = t(raw, 'landing.seo_description');
  return {
    title,
    description,
    alternates: { languages: { en: '/en', ru: '/ru' } },
    openGraph: { title, description, locale: raw, type: 'website' },
  };
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();

  return (
    <html lang={raw}>
      <body>{children}</body>
    </html>
  );
}
