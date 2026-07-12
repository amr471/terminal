'use client';

/**
 * Reveals its children as they scroll into view (P1.2b). A thin
 * IntersectionObserver wrapper, not an animation library — the actual
 * motion is CSS transitions on the .landing__reveal classes in
 * landing.css, which is also where prefers-reduced-motion is respected
 * (this component doesn't need its own reduced-motion branch: with
 * transition-duration collapsed to ~0 there, toggling the class still
 * "works," it's just instant instead of animated).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ScrollRevealProps {
  children: ReactNode;
  /** Stagger multiple reveals within the same section, in ms. */
  delayMs?: number;
}

export function ScrollReveal({ children, delayMs = 0 }: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`landing__reveal${visible ? ' landing__reveal--visible' : ''}`}
      style={{ transitionDelay: `${delayMs}ms` }}
    >
      {children}
    </div>
  );
}
