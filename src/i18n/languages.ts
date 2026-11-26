/**
 * Registry of the app's supported interface language codes.
 *
 * Pure data on purpose: the Worker's site-notice handling and the offline
 * backup validator import it, so it must stay free of translation
 * dictionaries.
 */

export const LANG_CODES = ['zh', 'zh-TW', 'yue', 'en', 'de', 'ja', 'ko', 'tr', 'ru', 'uk'] as const;

export type Lang = (typeof LANG_CODES)[number];

/**
 * Endonyms shown by the site-notice editor. The settings language picker in
 * `src/App.tsx` keeps its own established labels (正體中文 for zh-TW and
 * 廣東話 for yue).
 */
export const LANG_LABELS: Record<Lang, string> = {
    zh: '简体中文',
    'zh-TW': '繁體中文',
    yue: '粵語',
    en: 'English',
    de: 'Deutsch',
    ja: '日本語',
    ko: '한국어',
    tr: 'Türkçe',
    ru: 'Русский',
    uk: 'Українська',
};

export const isLangCode = (value: unknown): value is Lang =>
    typeof value === 'string' && (LANG_CODES as readonly string[]).includes(value);
