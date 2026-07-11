/**
 * Badge — status chips. Health states use the health palette, NOT green/red
 * (those are reserved for direction, CLAUDE.md §5).
 */
import type { HealthState } from '@terminal/types';

export interface HealthBadgeProps {
  state: HealthState;
  /** Localized label; caller passes t()-resolved text (no hardcoded strings). */
  label: string;
}

export function HealthBadge({ state, label }: HealthBadgeProps) {
  return (
    <span className={`t-badge t-badge--${state.toLowerCase()}`} title={label}>
      <span className="t-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
