import { CSSProperties, ReactNode } from 'react';
import { AccentColorName } from '@/design/tokens';

type Variant = 'default' | 'inset' | 'active' | 'terminal' | 'dialog';

export interface PixelPanelProps {
  variant?: Variant;
  title?: string;
  accent?: AccentColorName;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  noPadding?: boolean;
}

const borderByVariant: Record<Variant, string> = {
  default:  'var(--cth-panel-border)',
  inset:    'var(--cth-panel-border-inset)',
  active:   'var(--cth-panel-border)',  // accent overlay added separately
  terminal: 'var(--cth-panel-border-terminal)',
  dialog:   'var(--cth-panel-border-dialog)'
};

const fillByVariant: Record<Variant, string> = {
  default:  'var(--cth-cream-100)',
  inset:    'var(--cth-cream-200)',
  active:   'var(--cth-cream-100)',
  terminal: 'var(--cth-paper-100)',
  dialog:   'var(--cth-cream-50)'
};

export function PixelPanel({
  variant = 'default',
  title,
  accent,
  children,
  style,
  className,
  noPadding = false
}: PixelPanelProps) {
  const baseStyle: CSSProperties = {
    background: fillByVariant[variant],
    boxShadow: borderByVariant[variant],
    borderRadius: 'var(--cth-radius-lg)',
    padding: noPadding ? 0 : 'var(--cth-space-3)',
    position: 'relative',
    // Only titled panels clip — so the negative-margin header follows the
    // rounded corners. Untitled panels stay un-clipped so terminals, menus, and
    // popovers can overflow as before. A caller-supplied `overflow` still wins.
    ...(title ? { overflow: 'hidden' } : {}),
    ...style
  };

  // Active variant: a clean 1.5px accent ring plus a soft accent glow — replaces
  // the old chunky ink/accent/ink triple inset so selection reads as a modern
  // highlight rather than a heavy pixel frame.
  if (variant === 'active' && accent) {
    baseStyle.boxShadow = `inset 0 0 0 1.5px var(--cth-${accent}), 0 0 0 3px var(--cth-${accent}-light), var(--cth-shadow-sm)`;
  }

  return (
    <div className={className} style={baseStyle}>
      {title && (
        <div
          style={{
            margin: noPadding ? 0 : '-12px -12px 12px',
            padding: '7px 12px 6px',
            background: accent ? `var(--cth-${accent})` : 'var(--cth-cream-200)',
            color: 'var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-display)',
            fontSize: 'var(--cth-text-display-md)',
            fontWeight: 600,
            lineHeight: 'var(--cth-lh-display-md)',
            boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)'
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
