'use client';

/**
 * Telegram Login Widget (P1.2c), callback mode rather than redirect mode:
 * `data-onauth` hands the signed payload to a JS callback so this component
 * can POST it to /api/auth/telegram itself (through the same-origin proxy,
 * same as the rest of auth) instead of requiring the backend to also accept
 * a GET/query-string variant of the same payload.
 *
 * The widget script isn't a normal declarative <script> tag — on load it
 * replaces itself with an iframe *at its DOM position*, so it has to be
 * created imperatively and appended into a ref'd container rather than
 * rendered via next/script (which targets <head>/<body>, not an arbitrary
 * inline position).
 *
 * Requires the bot's domain to be authorized via @BotFather's /setdomain
 * first (docs/auth.md) — an account-setup step, not something this code can
 * do. If `botUsername` is unset, this renders nothing (same
 * optional-if-unconfigured pattern the backend already uses for providers).
 */
import { useEffect, useRef } from 'react';

export interface TelegramAuthUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthUser) => void;
  }
}

export interface TelegramLoginButtonProps {
  botUsername: string;
  onAuth: (user: TelegramAuthUser) => void;
}

export function TelegramLoginButton({ botUsername, onAuth }: TelegramLoginButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.onTelegramAuth = onAuth;

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '4');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    containerRef.current?.appendChild(script);

    return () => {
      delete window.onTelegramAuth;
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [botUsername, onAuth]);

  return <div ref={containerRef} className="landing__telegram-login" />;
}
