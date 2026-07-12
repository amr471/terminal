/**
 * Client-side signup validation — UX sugar only, never the source of truth.
 * The gateway's zod schema (services/api-gateway/src/authSchemas.ts
 * signupSchema) is authoritative; this exists so the form can show inline
 * errors before round-tripping to the server. Returns error *codes*, not
 * translated strings, so this stays localization-agnostic and unit-testable
 * without React/DOM.
 */

export type SignupFieldErrorCode = 'invalid_email' | 'password_too_short';

export interface SignupFieldErrors {
  email?: SignupFieldErrorCode;
  password?: SignupFieldErrorCode;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors authSchemas.ts's `password: z.string().min(10)`. */
export const PASSWORD_MIN_LENGTH = 10;

export function validateSignupInput(email: string, password: string): SignupFieldErrors {
  const errors: SignupFieldErrors = {};
  if (!EMAIL_RE.test(email.trim())) errors.email = 'invalid_email';
  if (password.length < PASSWORD_MIN_LENGTH) errors.password = 'password_too_short';
  return errors;
}
