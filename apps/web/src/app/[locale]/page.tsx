import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@terminal/types';
import { t, type MessageKey } from '@terminal/i18n';
import { SignupForm } from '../../components/SignupForm';
import { ScrollReveal } from '../../components/ScrollReveal';
import { buildTelegramLoginUrl } from '../../lib/telegramLoginUrl';

interface LandingPageProps {
  params: Promise<{ locale: string }>;
}

function LocaleSwitcher({ locale }: { locale: Locale }) {
  return (
    <nav className="landing__locale-switcher" aria-label="Language">
      <a href="/en" aria-current={locale === 'en' ? 'page' : undefined}>
        EN
      </a>
      <a href="/ru" aria-current={locale === 'ru' ? 'page' : undefined}>
        RU
      </a>
    </nav>
  );
}

function FeatureCard({
  locale,
  titleKey,
  bodyKey,
}: {
  locale: Locale;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}): ReactNode {
  return (
    <article className="landing__feature-card">
      <h3>{t(locale, titleKey)}</h3>
      <p>{t(locale, bodyKey)}</p>
    </article>
  );
}

const FEATURES: { titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { titleKey: 'landing.features.screener_title', bodyKey: 'landing.features.screener_body' },
  { titleKey: 'landing.features.liq_title', bodyKey: 'landing.features.liq_body' },
  { titleKey: 'landing.features.ai_title', bodyKey: 'landing.features.ai_body' },
];

export default async function LandingPage({ params }: LandingPageProps) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  // Origin is derived from the actual request rather than a hardcoded env
  // var — works the same in dev and any future deployment, and must match
  // whatever's authorized via @BotFather's /setdomain (docs/auth.md).
  const host = (await headers()).get('host') ?? 'localhost:3000';
  const origin = `https://${host}`;
  const telegramBotId = process.env.TELEGRAM_BOT_ID;
  const telegramLoginUrl = telegramBotId
    ? buildTelegramLoginUrl({
        botId: telegramBotId,
        origin,
        returnTo: `${origin}/api/auth/telegram/callback`,
      })
    : undefined;

  return (
    <main className="landing">
      <header className="landing__nav">
        <span className="landing__logo">{t(locale, 'app.name')}</span>
        <LocaleSwitcher locale={locale} />
      </header>

      <section className="landing__hero">
        <p className="landing__kicker">
          {t(locale, 'landing.hero_kicker')}
          <span className="landing__cursor" aria-hidden="true">
            _
          </span>
        </p>
        <h1 className="landing__title">{t(locale, 'app.tagline')}</h1>
        <p className="landing__subtitle">{t(locale, 'landing.hero_subtitle')}</p>
        <a className="landing__hero-cta" href="#signup">
          {t(locale, 'landing.signup.submit')}
        </a>
      </section>

      <section className="landing__features" aria-label={t(locale, 'landing.features_heading')}>
        <h2 className="landing__section-heading">{t(locale, 'landing.features_heading')}</h2>
        <div className="landing__feature-grid">
          {FEATURES.map((feature, i) => (
            <ScrollReveal key={feature.titleKey} delayMs={i * 100}>
              <FeatureCard locale={locale} titleKey={feature.titleKey} bodyKey={feature.bodyKey} />
            </ScrollReveal>
          ))}
        </div>
      </section>

      <section className="landing__signup" id="signup" aria-label={t(locale, 'auth.sign_up')}>
        <ScrollReveal>
          <h2 className="landing__section-heading">{t(locale, 'landing.signup_heading')}</h2>
          <SignupForm
            locale={locale}
            {...(telegramLoginUrl !== undefined ? { telegramLoginUrl } : {})}
          />
        </ScrollReveal>
      </section>
    </main>
  );
}
