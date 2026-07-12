'use client';

/**
 * Inline registration form (CLAUDE.md §1: "sign-up → straight into the
 * terminal"). Posts to /api/auth/signup, which next.config.mjs rewrites
 * server-side to the gateway — same-origin from the browser's point of view,
 * so the gateway's Secure session cookie round-trips correctly (see
 * next.config.mjs's comment for why that matters).
 *
 * The terminal itself doesn't exist yet (P1.3+), so "straight into the
 * terminal" is currently an inline success state rather than a redirect to
 * a route that would 404. Swap the success branch for a redirect to
 * `/${locale}/terminal` once P1.3 ships.
 */
import { useState, type FormEvent } from 'react';
import type { Locale } from '@terminal/types';
import { t } from '@terminal/i18n';
import { validateSignupInput, type SignupFieldErrors } from '../lib/validateSignup.js';
import { authErrorMessageKey } from '../lib/authErrorMessage.js';

export interface SignupFormProps {
  locale: Locale;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

interface SignupErrorBody {
  error?: { code?: string };
}

function isSignupErrorBody(value: unknown): value is SignupErrorBody {
  return typeof value === 'object' && value !== null;
}

export function SignupForm({ locale }: SignupFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

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
    } catch {
      setFormError(t(locale, 'error.generic'));
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <div className="landing__signup-success" role="status">
        <p className="landing__signup-success-title">{t(locale, 'landing.signup.success_title')}</p>
        <p>{t(locale, 'landing.signup.success_body', { email })}</p>
      </div>
    );
  }

  return (
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
        {status === 'submitting' ? t(locale, 'data.loading') : t(locale, 'landing.signup.submit')}
      </button>
    </form>
  );
}
