/** Accent palettes shared by the UI, the portable preference store, and backups. */
export const COLOR_PALETTES = ['terracotta', 'plum', 'teal'] as const;

export type ColorPalette = (typeof COLOR_PALETTES)[number];

export function isColorPalette(value: unknown): value is ColorPalette {
    return (COLOR_PALETTES as readonly unknown[]).includes(value);
}
