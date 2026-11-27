/**
 * The character sets the report's fonts are cut from, as JSON on stdout.
 *
 * `build-fonts.py` bundles this file with esbuild and runs it, so the subsets
 * are cut from the same list the runtime checks them against.
 */
import { LANG_CODES } from '../../i18n/languages';
import { reportFontCharacters } from '../pdf/charset';

const charsets: Record<string, string> = {};
for (const lang of LANG_CODES) {
    charsets[lang] = reportFontCharacters(lang);
}

process.stdout.write(JSON.stringify(charsets));
