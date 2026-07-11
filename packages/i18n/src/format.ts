/**
 * Locale-aware, STRING-DECIMAL-SAFE number formatting (architecture.md §4.3).
 * Values arrive as Dec strings and are formatted by digit manipulation —
 * never round-tripped through `Number`, so `0.30000000000000004` can't happen.
 * The one documented exception: formatCompact (display-only approximation).
 */
import type { Locale } from '@terminal/types';
import type { Dec } from '@terminal/types';

interface Separators {
  group: string;
  decimal: string;
}

const SEPARATORS: Record<Locale, Separators> = { en: sep('en'), ru: sep('ru') };

function sep(locale: string): Separators {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

/** Increment a digit string by one ('0999' → '1000'). */
function incDigits(digits: string): string {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i] ?? '0';
    if (d === '9') {
      out[i] = '0';
    } else {
      out[i] = String.fromCharCode(d.charCodeAt(0) + 1);
      return out.join('');
    }
  }
  return '1' + out.join('');
}

/** Round a Dec to `maxFrac` fraction digits, half-up, away from zero. */
export function roundDec(value: Dec, maxFrac: number): Dec {
  const neg = value.startsWith('-');
  const [intPart0, fracPart0] = (neg ? value.slice(1) : value).split('.');
  const intRaw = intPart0 ?? '0';
  const fracRaw = fracPart0 ?? '';
  if (fracRaw.length <= maxFrac) return value;
  let digits = intRaw + fracRaw.slice(0, maxFrac);
  if (fracRaw.charCodeAt(maxFrac) - 48 >= 5) digits = incDigits(digits);
  const intLen = digits.length - maxFrac;
  const intPart = (intLen > 0 ? digits.slice(0, intLen) : '0').replace(/^0+(?=\d)/, '');
  const fracPart = maxFrac > 0 ? digits.slice(Math.max(intLen, 0)).padStart(maxFrac, '0') : '';
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg && !/^0(\.0+)?$/.test(result) ? `-${result}` : result;
}

/** Shift the decimal point right by `places` (×10^places), string-safe. */
export function shiftDec(value: Dec, places: number): Dec {
  const neg = value.startsWith('-');
  const [intPart0, fracPart0] = (neg ? value.slice(1) : value).split('.');
  const intRaw = intPart0 ?? '0';
  const fracRaw = fracPart0 ?? '';
  const digits = intRaw + fracRaw;
  const pointAt = intRaw.length + places;
  let result: string;
  if (pointAt >= digits.length) {
    result = digits.padEnd(pointAt, '0');
  } else if (pointAt <= 0) {
    result = `0.${'0'.repeat(-pointAt)}${digits}`;
  } else {
    result = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  }
  result = result.replace(/^0+(?=\d)/, '');
  if (result.includes('.')) result = result.replace(/\.?0+$/, '');
  return neg && !/^0$/.test(result) ? `-${result}` : result;
}

export interface FormatDecOptions {
  minFrac?: number;
  maxFrac?: number;
  useGrouping?: boolean;
  /** Prefix positive values with '+' (up/down columns). */
  explicitSign?: boolean;
}

/** Format a Dec for display in `locale`. Pure digit/separator work. */
export function formatDec(value: Dec, locale: Locale, opts: FormatDecOptions = {}): string {
  const { minFrac = 0, maxFrac = 8, useGrouping = true, explicitSign = false } = opts;
  const { group, decimal } = SEPARATORS[locale];
  const rounded = roundDec(value, maxFrac);
  const neg = rounded.startsWith('-');
  const [intPart0, fracPart0] = (neg ? rounded.slice(1) : rounded).split('.');
  const intPart = intPart0 ?? '0';
  let frac = (fracPart0 ?? '').replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  const grouped = useGrouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group) : intPart;
  const sign = neg ? '-' : explicitSign ? '+' : '';
  return sign + grouped + (frac ? decimal + frac : '');
}

/**
 * Format a FRACTION Dec ('-0.052') as a percentage ('-5.2%' / '−5,2 %').
 * Multiplication by 100 is a string-safe decimal-point shift.
 */
export function formatPercentFromFraction(
  value: Dec,
  locale: Locale,
  opts: FormatDecOptions = {},
): string {
  const pct = formatDec(shiftDec(value, 2), locale, { maxFrac: 2, ...opts });
  return locale === 'ru' ? `${pct}\u00a0%` : `${pct}%`;
}

/**
 * Compact display for large magnitudes ('1.2B' / '1,2 млрд').
 * DISPLAY-ONLY: goes through Number, so it approximates — never feed the
 * output back into anything that computes.
 */
export function formatCompact(value: Dec, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value));
}
