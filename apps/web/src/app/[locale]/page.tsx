import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@terminal/types';
import { t, type MessageKey } from '@terminal/i18n';
import { SignupForm } from '../../components/SignupForm.js';

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

export default async function LandingPage({ params }: LandingPageProps) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  return (
    <main className="landing">
      <header className="landing__nav">
        <span className="landing__logo">{t(locale, 'app.name')}</span>
        <LocaleSwitcher locale={locale} />
      </header>

      <section className="landing__hero">
        <p className="landing__kicker">{t(locale, 'landing.hero_kicker')}</p>
        <h1 className="landing__title">{t(locale, 'app.tagline')}</h1>
        <p className="landing__subtitle">{t(locale, 'landing.hero_subtitle')}</p>
        <a className="landing__hero-cta" href="#signup">
          {t(locale, 'landing.signup.submit')}
        </a>
      </section>

      <section className="landing__features" aria-label={t(locale, 'landing.features_heading')}>
        <h2 className="landing__section-heading">{t(locale, 'landing.features_heading')}</h2>
        <div className="landing__feature-grid">
          <FeatureCard
            locale={locale}
            titleKey="landing.features.screener_title"
            bodyKey="landing.features.screener_body"
          />
          <FeatureCard
            locale={locale}
            titleKey="landing.features.liq_title"
            bodyKey="landing.features.liq_body"
          />
          <FeatureCard
            locale={locale}
            titleKey="landing.features.ai_title"
            bodyKey="landing.features.ai_body"
          />
        </div>
      </section>

      <section className="landing__signup" id="signup" aria-label={t(locale, 'auth.sign_up')}>
        <h2 className="landing__section-heading">{t(locale, 'landing.signup_heading')}</h2>
        <SignupForm locale={locale} />
      </section>
    </main>
  );
}
