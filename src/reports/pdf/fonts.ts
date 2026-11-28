import type { Lang } from '../../i18n/languages';

/**
 * The fonts the report embeds.
 *
 * A PDF that reaches a clinician has to show the app's language, and the
 * standard PDF fonts cannot: they are Latin-only and carry no Chinese, Japanese
 * or Korean glyphs. So the report embeds a subset of Noto Sans, cut down to
 * the characters that language's report can draw (see `../pdf/charset.ts` and
 * `../fonts/build-fonts.py`).
 *
 * The font travels inside the bundle, not over the network: Vite inlines the
 * file as a base64 data URI, so nothing is fetched at runtime and the report
 * works with no connection at all. Each language is imported on its own, so a
 * report in one language never carries the fonts of the other nine.
 */

/** The name jsPDF knows the report's font by. */
export const REPORT_FONT_NAME = 'Report';

type FontModule = { default: string };

const FONT_SOURCES: Record<Lang, () => Promise<FontModule>> = {
    en: () => import('../fonts/NotoSans-Latin.ttf?inline'),
    de: () => import('../fonts/NotoSans-Latin.ttf?inline'),
    tr: () => import('../fonts/NotoSans-Latin.ttf?inline'),
    ru: () => import('../fonts/NotoSans-Latin.ttf?inline'),
    uk: () => import('../fonts/NotoSans-Latin.ttf?inline'),
    zh: () => import('../fonts/NotoSansSC-zh.ttf?inline'),
    'zh-TW': () => import('../fonts/NotoSansTC-zh-TW.ttf?inline'),
    yue: () => import('../fonts/NotoSansHK-yue.ttf?inline'),
    ja: () => import('../fonts/NotoSansJP-ja.ttf?inline'),
    ko: () => import('../fonts/NotoSansKR-ko.ttf?inline'),
};

const BASE64_FONT_URI = /^data:[^,]*;base64,([a-zA-Z0-9+/]+={0,2})$/;

export interface LoadedFont {
    /** The name jsPDF knows the font by. */
    name: string;
    /** The name the font file is held under in jsPDF's virtual file system. */
    file: string;
    /** The font itself, base64. */
    base64: string;
}

/** The font a language's report needs, loaded and ready to embed. */
export const loadReportFont = async (lang: Lang): Promise<LoadedFont> => {
    const module = await FONT_SOURCES[lang]();
    const base64 = BASE64_FONT_URI.exec(module.default)?.[1];
    if (!base64 || base64.length % 4 !== 0) throw new Error(`Invalid bundled report font for ${lang}.`);
    return { name: REPORT_FONT_NAME, file: 'report-' + lang + '.ttf', base64 };
};
