'use client';

/**
 * Wraps table-cell content that might not fit its column. `ScreenerTable`
 * and `BestPriceTable` both use fixed pixel column widths (table-layout:
 * fixed, P1.7b) so scrolling a virtualized table doesn't reflow every
 * column — but that means long values (venue names like "HYPERLIQUID",
 * long symbols) get clipped. Per user report (2026-07-17: "if the text
 * doesn't fit in the column, I want it to be a running line"), on hover —
 * if the content actually overflows its box — scroll it left far enough to
 * reveal the clipped end, pause, then scroll back. Deliberately
 * hover-triggered rather than a continuously-animating ticker: constant
 * motion across every visible row of a dense virtualized table would be
 * both distracting and, with dozens of rows animating simultaneously, a
 * real paint cost.
 *
 * Overflow is (re-)measured lazily on `mouseenter` rather than via a
 * `ResizeObserver`, so it stays correct after a column-width resize
 * without paying for a live observer per cell.
 */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface MarqueeTextProps {
  children: ReactNode;
}

export function MarqueeText({ children }: MarqueeTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    setDistance(overflow > 1 ? overflow : 0);
  };

  const style =
    distance > 0 ? ({ '--t-marquee-distance': `${distance}px` } as CSSProperties) : undefined;

  return (
    <span
      ref={ref}
      className={`t-marquee${distance > 0 ? ' t-marquee--overflowing' : ''}`}
      onMouseEnter={measure}
      style={style}
    >
      <span className="t-marquee__inner">{children}</span>
    </span>
  );
}
