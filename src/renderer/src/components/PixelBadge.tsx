import { CSSProperties } from 'react';

export type StatusKind =
  | 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'success' | 'ghost'
  // #5C — richer states driven by real events: PreCompact/PostCompact hooks and
  // the Lane A circuit breaker (#6) respectively.
  | 'compacting' | 'looping';

export interface PixelBadgeProps {
  status: StatusKind;
  label?: string;
  style?: CSSProperties;
}

const colorByStatus: Record<StatusKind, string> = {
  idle:     'var(--cth-status-idle)',
  thinking: 'var(--cth-status-thinking)',
  working:  'var(--cth-status-working)',
  waiting:  'var(--cth-status-waiting)',
  blocked:  'var(--cth-status-blocked)',
  success:  'var(--cth-status-success)',
  ghost:    'var(--cth-status-ghost)',
  compacting: 'var(--cth-status-compacting)',
  looping:    'var(--cth-status-looping)'
};

// Human-readable labels. "blocked" is reserved for the god agent waiting on YOU,
// so it reads as "needs you"; sub-agents waiting on god/another agent are
// "waiting", which is honest about who they're actually stalled on.
const labelByStatus: Record<StatusKind, string> = {
  idle:     'idle',
  thinking: 'working',
  working:  'working',
  waiting:  'waiting',
  blocked:  'needs you',
  success:  'done',
  ghost:    'gone',
  compacting: 'compacting',
  looping:    'looping'
};

export function PixelBadge({ status, label, style }: PixelBadgeProps) {
  const text = label ?? labelByStatus[status] ?? status;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        background: 'var(--cth-cream-50)',
        boxShadow: `inset 0 0 0 1px ${colorByStatus[status]}`,
        borderRadius: 'var(--cth-radius-pill)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 'var(--cth-text-body-sm)',
        fontWeight: 500,
        lineHeight: '16px',
        color: 'var(--cth-ink-700)',
        userSelect: 'none',
        ...style
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          background: colorByStatus[status],
          // Soft halo instead of a hard ink outline — reads as a status light.
          boxShadow: `0 0 0 2px color-mix(in srgb, ${colorByStatus[status]} 22%, transparent)`
        }}
      />
      {text}
    </span>
  );
}
