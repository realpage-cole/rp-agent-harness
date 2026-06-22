import { CSSProperties, ReactNode, useState } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

export interface PixelButtonProps {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: CSSProperties;
}

const heightBySize: Record<Size, number> = { sm: 24, md: 32, lg: 40 };
const padBySize: Record<Size, string> = { sm: '0 8px', md: '0 12px', lg: '0 16px' };

export function PixelButton({
  variant = 'primary',
  size = 'md',
  children,
  onClick,
  disabled = false,
  fullWidth = false,
  style
}: PixelButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);

  const palette = (() => {
    switch (variant) {
      case 'primary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-ink-700)' : 'var(--cth-ink-900)'),
          text:    'var(--cth-cream-50)',
          border:  'var(--cth-ink-900)'
        };
      case 'secondary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)'),
          text:    'var(--cth-ink-900)',
          border:  'var(--cth-ink-100)'
        };
      case 'ghost':
        return {
          fill:    hover ? 'var(--cth-cream-200)' : 'transparent',
          text:    'var(--cth-ink-700)',
          border:  'var(--cth-ink-100)'
        };
      case 'destructive':
        return {
          // Solid red on hover, soft red at rest — clearly distinct from the
          // indigo primary. White text for AA contrast on the red fill.
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-danger)' : 'var(--cth-danger-light)'),
          text:    disabled ? 'var(--cth-ink-300)' : (hover ? 'var(--cth-cream-50)' : 'var(--cth-danger)'),
          border:  'transparent'
        };
    }
  })();

  // Modern elevation: a 1px inset hairline + a soft drop shadow at rest, lifting
  // to a larger shadow on hover and settling flush on press (replaces the old
  // hard 2px offset + translateY pixel button).
  const ring = palette.border === 'transparent' ? '' : `inset 0 0 0 1px ${palette.border}`;
  // Ghost is a low-emphasis button: hairline only, no drop shadow / lift.
  const flat = variant === 'ghost';
  const drop = disabled || flat ? '' : pressed ? 'var(--cth-shadow-sm)' : hover ? 'var(--cth-shadow-md)' : 'var(--cth-shadow-sm)';
  const boxShadow = [ring, drop].filter(Boolean).join(', ') || 'none';

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => { setPressed(false); setHover(false); }}
      onMouseEnter={() => setHover(true)}
      disabled={disabled}
      style={{
        height: heightBySize[size],
        padding: padBySize[size],
        background: palette.fill,
        color: palette.text,
        border: 'none',
        borderRadius: 'var(--cth-radius-md)',
        boxShadow,
        transform: disabled || flat ? 'none' : pressed ? 'translateY(1px)' : hover ? 'translateY(-1px)' : 'none',
        transition: 'background var(--cth-dur-fast) var(--cth-ease), color var(--cth-dur-fast) var(--cth-ease), box-shadow var(--cth-dur) var(--cth-ease), transform var(--cth-dur) var(--cth-ease)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: size === 'lg' ? 'var(--cth-text-body-lg)' : 'var(--cth-text-body-md)',
        fontWeight: variant === 'primary' || variant === 'destructive' ? 600 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        userSelect: 'none',
        ...style
      }}
    >
      {children}
    </button>
  );
}
