// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  cream: {
    50: 0xffffff,
    100: 0xfafafa,
    200: 0xf1f2f4,
    300: 0xe4e6ea
  },
  paper: {
    100: 0xffffff,
    200: 0xf6f7f9
  },
  ink: {
    900: 0x1b1f24,
    700: 0x3a4048,
    500: 0x6b727b,
    300: 0xaab1ba,
    100: 0xdce0e5
  },
  accent: {
    coral: 0x6366f1,
    coralLight: 0xc7d2fe,
    mint: 0x10b981,
    mintLight: 0xa7f3d0,
    sky: 0x0ea5e9,
    skyLight: 0xbae6fd,
    lemon: 0xf59e0b,
    lemonLight: 0xfde68a,
    lilac: 0x8b5cf6,
    lilacLight: 0xddd6fe,
    peach: 0xf97316,
    peachLight: 0xfed7aa
  },
  status: {
    idle: 0xaab1ba,
    thinking: 0x0ea5e9,
    working: 0xf59e0b,
    blocked: 0xef4444,
    success: 0x10b981,
    ghost: 0xdce0e5
  },
  world: {
    grassLight: 0xeef0f3,
    grassDark: 0xe4e6ea,
    woodLight: 0xf1f2f4,
    woodDark: 0xdce0e5,
    path: 0xf6f7f9,
    wall: 0xaab1ba
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

export const type = {
  display: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  ui: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
} as const;

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
