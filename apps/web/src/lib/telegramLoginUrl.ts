/**
 * Builds Telegram's OAuth "Login URL" redirect
 * (https://core.telegram.org/widgets/login#link-with-a-bot-username) — the
 * non-iframe variant, used so the landing page's Telegram button can be a
 * plain styled <a>, matching Google/Discord, instead of Telegram's own
 * widget chrome (components/TelegramLoginButton.tsx, kept but unused here).
 * Pure function: no fetch, no DOM — easy to unit test without jsdom.
 */
export interface TelegramLoginUrlParams {
  botId: string;
  /** The site's own origin, must match what's authorized via @BotFather's /setdomain. */
  origin: string;
  /** Where Telegram redirects back to after login — GET query params, not a fragment. */
  returnTo: string;
}

export function buildTelegramLoginUrl({ botId, origin, returnTo }: TelegramLoginUrlParams): string {
  const query = new URLSearchParams({
    bot_id: botId,
    origin,
    embed: '0',
    request_access: 'write',
    return_to: returnTo,
  });
  return `https://oauth.telegram.org/auth?${query.toString()}`;
}
