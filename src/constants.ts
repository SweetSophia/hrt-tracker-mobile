export const APP_THEMES = Object.freeze(['light', 'dark', 'system', 'mono'] as const);

export type AppTheme = (typeof APP_THEMES)[number];

export const isAppTheme = (value: unknown): value is AppTheme =>
    typeof value === 'string' && (APP_THEMES as readonly string[]).includes(value);
