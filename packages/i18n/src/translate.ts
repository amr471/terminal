/**
 * Minimal, framework-agnostic translator. The web app will layer next-intl on
 * top of the same catalogs (P1.3); services (gateway, telegram-bot) and the
 * LLM prompt builder use this directly so ALL surfaces share one source of
 * strings (CLAUDE.md §8).
 */
import type { Locale } from '@terminal/types';
import { en, type Catalog, type Message, type MessageKey } from './catalogs/en.js';
import { ru } from './catalogs/ru.js';

export const CATALOGS: Record<Locale, Catalog> = { en, ru };

export type TranslateParams = Record<string, string | number>;

const pluralRules: Record<Locale, Intl.PluralRules> = {
  en: new Intl.PluralRules('en'),
  ru: new Intl.PluralRules('ru'),
};

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function resolvePlural(message: Exclude<Message, string>, locale: Locale, count: number): string {
  const category = pluralRules[locale].select(count);
  return (
    (category === 'one' && message.one) ||
    (category === 'few' && message.few) ||
    (category === 'many' && message.many) ||
    message.other
  );
}

/**
 * Translate `key` into `locale`, interpolating {params}. Plural messages
 * select their CLDR form from `params.count`. Missing keys fall back to the
 * English catalog (and ultimately to the key itself) — never throw over copy.
 */
export function t(locale: Locale, key: MessageKey, params: TranslateParams = {}): string {
  const message: Message = CATALOGS[locale][key] ?? en[key] ?? key;
  if (typeof message === 'string') return interpolate(message, params);
  const count = typeof params.count === 'number' ? params.count : 0;
  return interpolate(resolvePlural(message, locale, count), params);
}
