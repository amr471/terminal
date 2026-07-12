/**
 * Google OAuth (authorization-code + OIDC id_token verification) via
 * google-auth-library — avoids hand-rolling JWKS/JWT verification.
 */
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
}

function requireGoogleConfig(): NonNullable<typeof config.google> {
  if (!config.google) {
    throw new Error('Google OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID/SECRET unset)');
  }
  return config.google;
}

function client(): OAuth2Client {
  const g = requireGoogleConfig();
  return new OAuth2Client(g.clientId, g.clientSecret, g.redirectUri);
}

export function buildGoogleAuthUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

/** Exchanges an authorization code for a verified Google identity. Throws on any failure. */
export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const g = requireGoogleConfig();
  const oauth2 = client();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.id_token) throw new Error('Google token exchange returned no id_token');

  const ticket = await oauth2.verifyIdToken({ idToken: tokens.id_token, audience: g.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('Google id_token payload missing sub/email');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified ?? false,
    name: payload.name,
  };
}
