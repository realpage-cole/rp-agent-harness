import { CSSProperties } from 'react';
import { AccentColorName } from '@/design/tokens';

export interface AvatarProps {
  /** Drives the initials (first letters of up to two words). */
  name: string;
  /** Accent ring + tint color. */
  accent: AccentColorName;
  /** Diameter in px. */
  size?: number;
  style?: CSSProperties;
}

/** First letter of up to the first two words, uppercased (e.g. "Backend
 *  Engineer" → "BE", "orchestrator" → "O"). */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Initials in an accent-colored circle — the agent's visual identity, derived
 * from its name + accent color. Pure markup, no assets.
 */
export function Avatar({ name, accent, size = 40, style }: AvatarProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        background: `var(--cth-${accent}-light)`,
        boxShadow: `inset 0 0 0 2px var(--cth-${accent})`,
        color: 'var(--cth-ink-900)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--cth-font-display)',
        fontSize: Math.round(size * 0.34),
        lineHeight: 1,
        userSelect: 'none',
        ...style
      }}
    >
      {initialsFor(name)}
    </div>
  );
}
