/**
 * NumCell — every number in the terminal goes through this: mono font,
 * right-aligned, optional direction coloring derived from the Dec string
 * (never from float parsing).
 */
import type { Dec, Locale } from '@terminal/types';
import { formatDec, formatPercentFromFraction, type FormatDecOptions } from '@terminal/i18n';
import { decDirection, directionClass } from '../direction.js';

export interface NumCellProps {
  value: Dec;
  locale: Locale;
  /** 'plain' renders as-is; 'percent' treats value as a fraction (0.052 → 5.2%). */
  mode?: 'plain' | 'percent';
  /** Color by sign (green up / red down). Off by default: color is a claim. */
  directional?: boolean;
  format?: FormatDecOptions;
}

export function NumCell({
  value,
  locale,
  mode = 'plain',
  directional = false,
  format = {},
}: NumCellProps) {
  const text =
    mode === 'percent'
      ? formatPercentFromFraction(value, locale, { explicitSign: directional, ...format })
      : formatDec(value, locale, format);
  const dirClass = directional ? ` ${directionClass(decDirection(value))}` : '';
  return <span className={`t-num${dirClass}`}>{text}</span>;
}
