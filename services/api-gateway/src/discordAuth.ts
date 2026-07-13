/**
 * Discord OAuth (authorization-code flow). Unlike Google, Discord has no
 * OpenID Connect / id_token to verify — it's plain OAuth2 plus a REST call
 * to fetch the profile, so this uses the platform's built-in `fetch` rather
 * than pulling in a client library the way googleAuth.ts needs
 * google-auth-library for OIDC verification.
 */
import { config } from './config.js';

export interface DiscordIdentity {
  id: string;
  email: string | null;
  /** Discord's own "has this email been verified" flag — same trust gate
   * googleAuth.ts applies to `email_verified` before linking an account. */
  verified: boolean;
  username?: string | undefined;
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}

interface DiscordUserResponse {
  id: string;
  username?: string;
  email?: string | null;
  verified?: boolean;
}

function requireDiscordConfig(): NonNullable<typeof config.discord> {
  if (!config.discord) {
    throw new Error('Discord OAuth is not configured (DISCORD_OAUTH_CLIENT_ID/SECRET unset)');
  }
  return config.discord;
}

export function buildDiscordAuthUrl(state: string): string {
  const d = requireDiscordConfig();
  const params = new URLSearchParams({
    client_id: d.clientId,
    redirect_uri: d.redirectUri,
    response_type: 'code',
    scope: 'identify email',
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/** Exchanges an authorization code for a Discord identity. Throws on any failure. */
export async function exchangeDiscordCode(code: string): Promise<DiscordIdentity> {
  const d = requireDiscordConfig();

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: d.clientId,
      client_secret: d.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: d.redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error('Discord token exchange failed');
  const tokens = (await tokenRes.json()) as DiscordTokenResponse;
  if (!tokens.access_token) throw new Error('Discord token exchange returned no access_token');

  const profileRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `${tokens.token_type} ${tokens.access_token}` },
  });
  if (!profileRes.ok) throw new Error('Discord profile fetch failed');
  const profile = (await profileRes.json()) as DiscordUserResponse;
  if (!profile.id) throw new Error('Discord profile response missing id');

  return {
    id: profile.id,
    email: profile.email ?? null,
    verified: profile.verified ?? false,
    username: profile.username,
  };
}
