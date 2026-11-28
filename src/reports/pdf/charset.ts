import { TRANSLATIONS } from '../../i18n/translations';
import { REPORT_COPY } from '../../i18n/reportCopy';
import type { Lang } from '../../i18n/languages';
import { formatDay, formatDayShort, reportLocale } from '../labels';

/**
 * The characters one language's report can put on a page.
 *
 * The PDF embeds a subset font, so the subset has to hold every character the
 * renderer can draw. That set is not "all of Unicode": it is the report's own
 * wording, the drug, route and form names it prints, the month names the
 * locale contributes, and the digits and punctuation every report carries.
 * A subset built from exactly this is a fraction of the size of the whole
 * font, which is what keeps a CJK report small enough to send.
 *
 * `src/reports/fonts/build-fonts.py` builds the subsets from this list, and
 * `tests/reportsPdf.test.ts` checks the shipped subsets still cover it. When
 * a translation changes, the test fails and names the script to run.
 */

/** The keys whose values reach the page besides the report's own copy. */
const EXTRA_KEYS = [
    'export.pdf.title',
    'export.pdf.generated_on',
    'export.pdf.history',
    'export.pdf.labs',
    'export.col.date',
    'export.col.item',
    'export.col.unit',
    'lab.assay',
    'mode.transfem',
    'mode.transmasc',
    'regimen.per_day',
    'route.patchRemove',
] as const;

/** The catalog the report names things from. */
const CATALOG_PREFIXES = ['ester.', 'route.', 'regimen.', 'gel.site.', 'lab.assay.'];

/** Punctuation, symbols and the ASCII a report needs whatever the language. */
const ALWAYS = [
    ' !\\"#$%&\'()*+,-./0123456789:;<=>?@',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`',
    'abcdefghijklmnopqrstuvwxyz{|}~',
    'µμ°·×÷±–—…‰€£¥°',
].join('');

/** The months the locale contributes, in both forms the report prints. */
const monthCharacters = (lang: Lang): string => {
    const days: string[] = [];
    for (let month = 0; month < 12; month += 1) {
        for (const day of [1, 11, 21, 28]) {
            const date = new Date(2024, month, day, 12, 0, 0, 0);
            days.push(formatDay(lang, date), formatDayShort(lang, date));
        }
    }
    return days.join('');
};

/**
 * The list separator the locale contributes. Japanese and Chinese put a
 * comma-like mark between items that is not in any of the translated
 * sentences, so it has to be asked for rather than assumed.
 */
const listCharacters = (lang: Lang): string => {
    const format = new Intl.ListFormat(reportLocale(lang));
    return format.format(['a', 'b']) + format.format(['a', 'b', 'c']);
};

/**
 * Every character the report can draw in one language.
 *
 * The report copy is read from the language pack itself rather than from a
 * fallback: a key the pack is missing would fall back to another language's
 * wording, and the font would have to carry that script too. Every pack
 * carries every report key, and the test keeps it that way.
 */
export const reportFontCharacters = (lang: Lang): string => {
    const pack = (TRANSLATIONS as Record<string, Record<string, string>>)[lang] ?? {};
    const reportCopy = REPORT_COPY[lang] ?? {};
    const parts: string[] = [ALWAYS, monthCharacters(lang), listCharacters(lang)];
    for (const key of EXTRA_KEYS) {
        if (pack[key]) parts.push(pack[key]);
    }
    for (const [key, value] of Object.entries(reportCopy)) {
        parts.push(value);
        if (!pack[key]) parts.push(key);
    }
    for (const [key, value] of Object.entries(pack)) {
        if (CATALOG_PREFIXES.some(prefix => key.startsWith(prefix))) parts.push(value);
    }
    return [...new Set(parts.join(''))].sort().join('');
};

/** The locale a language's report is written in, for the build script. */
export const charsetLocale = reportLocale;
