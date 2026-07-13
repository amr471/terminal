'use client';

/**
 * Inline registration form (CLAUDE.md §1: "sign-up → straight into the
 * terminal"). Posts to /api/auth/signup, which next.config.mjs rewrites
 * server-side to the gateway — same-origin from the browser's point of view,
 * so the gateway's Secure session cookie round-trips correctly (see
 * next.config.mjs's comment for why that matters).
 *
 * On success, redirects straight to `/${locale}/terminal` (P1.3) rather
 * than showing an inline message — the terminal route now exists and is
 * session-gated on that same cookie, which the browser already has by the
 * time this redirect fires (the fetch response's Set-Cookie is applied
 * before this callback runs).
 */
import { useCallback, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@terminal/types';
import { t } from '@terminal/i18n';
import { validateSignupInput, type SignupFieldErrors } from '../lib/validateSignup';
import { authErrorMessageKey } from '../lib/authErrorMessage';
import { TelegramLoginButton, type TelegramAuthUser } from './TelegramLoginButton';

export interface SignupFormProps {
  locale: Locale;
  /** Undefined when TELEGRAM_BOT_USERNAME isn't configured — same
   * optional-if-unconfigured pattern the backend uses (docs/auth.md). */
  telegramBotUsername?: string;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

interface SignupErrorBody {
  error?: { code?: string };
}

function isSignupErrorBody(value: unknown): value is SignupErrorBody {
  return typeof value === 'object' && value !== null;
}

export function SignupForm({ locale, telegramBotUsername }: SignupFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const handleTelegramAuth = useCallback(
    (user: TelegramAuthUser) => {
      setStatus('submitting');
      setFormError(null);
      fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      })
        .then((res) => {
          if (!res.ok) throw new Error('telegram auth failed');
          setStatus('success');
          router.push(`/${locale}/terminal`);
        })
        .catch(() => {
          setFormError(t(locale, 'landing.signup.telegram_error'));
          setStatus('error');
        });
    },
    [locale, router],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const errors = validateSignupInput(email, password);
    setFieldErrors(errors);
    if (errors.email || errors.password) return;

    setStatus('submitting');
    setFormError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          locale,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const parsed: unknown = await res.json().catch(() => null);
        const code = isSignupErrorBody(parsed) ? parsed.error?.code : undefined;
        setFormError(t(locale, authErrorMessageKey(code)));
        setStatus('error');
        return;
      }

      setStatus('success');
      router.push(`/${locale}/terminal`);
    } catch {
      setFormError(t(locale, 'error.generic'));
      setStatus('error');
    }
  }

  return (
    <div className="landing__signup-wrapper">
      <form
        className="landing__signup-form"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <label className="landing__field">
          <span>{t(locale, 'auth.email')}</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? 'signup-email-error' : undefined}
          />
          {fieldErrors.email && (
            <span id="signup-email-error" className="landing__field-error" role="alert">
              {t(locale, 'landing.signup.error_invalid_email')}
            </span>
          )}
        </label>

        <label className="landing__field">
          <span>{t(locale, 'auth.password')}</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? 'signup-password-error' : undefined}
          />
          {fieldErrors.password && (
            <span id="signup-password-error" className="landing__field-error" role="alert">
              {t(locale, 'landing.signup.error_password_too_short')}
            </span>
          )}
        </label>

        <label className="landing__field">
          <span>{t(locale, 'landing.signup.display_name')}</span>
          <input
            type="text"
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        {formError && (
          <p className="landing__form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" className="landing__submit" disabled={status === 'submitting'}>
          {status === 'submitting'
            ? t(locale, 'data.loading')
            : t(locale, 'landing.signup.submit')}
        </button>
      </form>

      <div className="landing__signup-divider" role="separator">
        <span>{t(locale, 'landing.signup.or_continue_with')}</span>
      </div>

      <div className="landing__signup-social">
        <a className="landing__social-button landing__social-button--google" href="/api/auth/google">
          {t(locale, 'landing.signup.google')}
        </a>
        {telegramBotUsername && (
          <TelegramLoginButton botUsername={telegramBotUsername} onAuth={handleTelegramAuth} />
        )}
      </div>
    </div>
  );
}
