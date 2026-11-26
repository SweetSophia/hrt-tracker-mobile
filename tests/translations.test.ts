import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_THEMES } from '../src/constants';
import { APPEARANCE_COPY } from '../src/i18n/appearanceCopy';
import { DE } from '../src/i18n/de';
import { MOBILE_CREDIT_KEYS, MOBILE_CREDITS } from '../src/i18n/mobileCredits';
import { getShareCopy, type ShareCopy } from '../src/i18n/share';
import { TRANSLATIONS } from '../src/i18n/translations';

// A language pack may start from another one with a spread, but a spread
// further down overwrites every key written above it. That is how the Turkish
// strings added in 1.5.1, the F2F how-to among them, reached readers in English.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/i18n/translations.ts'), 'utf8').split('\n');
const locales = Object.keys(TRANSLATIONS) as (keyof typeof TRANSLATIONS)[];
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();

describe('language packs', () => {
    it('spread a base pack only before their own strings', () => {
        const late = source.flatMap((line, i) => {
            if (!/^\s*\.\.\./.test(line)) return [];
            let before = i - 1;
            while (before >= 0 && source[before].trim() === '') before--;
            const previous = source[before].trim();
            return previous.endsWith('{') || previous.startsWith('...') ? [] : [`line ${i + 1}: ${line.trim()}`];
        });
        expect(late).toEqual([]);
    });

    it('exposes the mobile credit copy in every supported locale', () => {
        for (const locale of Object.keys(MOBILE_CREDITS) as (keyof typeof MOBILE_CREDITS)[]) {
            for (const key of MOBILE_CREDIT_KEYS) {
                expect(TRANSLATIONS[locale][key]).toBe(MOBILE_CREDITS[locale][key]);
                expect(TRANSLATIONS[locale][key].trim()).toBeTruthy();
            }
        }
    });

    it('has a label for every display mode in each supported locale', () => {
        for (const locale of locales) {
            for (const mode of APP_THEMES) {
                const key = `theme.${mode}` as const;
                expect(TRANSLATIONS[locale][key]?.trim(), `${locale} ${key}`).toBeTruthy();
            }
        }
    });

    it('keep the Turkish strings written for the F2F how-to', () => {
        const tr = TRANSLATIONS.tr as Record<string, string>;
        const en = TRANSLATIONS.en as Record<string, string>;
        expect(tr['f2f.guide']).toBe('Nasıl kullanılır');
        for (const key of ['f2f.step_export_desc', 'f2f.step_import_hint', 'f2f.step_encrypt_hint']) {
            expect(tr[key]).not.toBe(en[key]);
        }
    });
});

describe('loading copy', () => {
    for (const lang of locales) {
        it(`${lang} has a loading label`, () => {
            const pack = TRANSLATIONS[lang] as Record<string, string>;
            expect(pack['common.loading']).toBeTruthy();
        });
    }
});

describe('age model copy', () => {
    for (const lang of locales) {
        it(`${lang} has age band and warning copy`, () => {
            const pack = TRANSLATIONS[lang] as Record<string, string>;
            expect(pack['age.band']).toContain('{range}');
            expect(pack['age.warning.minor']).toBeTruthy();
            expect(pack['age.warning.prepubertal']).toBeTruthy();
            if (lang === 'en') {
                expect(pack['age.warning.prepubertal']).toContain('not a dosing recommendation');
            }
            expect(pack['age.warning.extrapolated']).toBeTruthy();
            expect(pack['age.explain']).toContain('{ref}');
        });
    }
});

describe('complete language packs', () => {
    const en = TRANSLATIONS.en as Record<string, string>;
    const authored = {
        de: { ...DE, ...MOBILE_CREDITS.de, ...APPEARANCE_COPY.de },
        ru: TRANSLATIONS.ru,
        uk: TRANSLATIONS.uk,
    };

    for (const [lang, directCopy] of Object.entries(authored)) {
        const pack: Record<string, string> = directCopy;

        it(`${lang} authors nonempty text for every English key and no others`, () => {
            expect(Object.keys(en).filter(k => !pack[k]?.trim())).toEqual([]);
            expect(Object.keys(pack).filter(k => !(k in en))).toEqual([]);
        });

        it(`${lang} keeps each string's placeholders`, () => {
            const off = Object.keys(en).filter(k => placeholders(en[k]).join() !== placeholders(pack[k] ?? '').join());
            expect(off).toEqual([]);
        });
    }
});

it('German share copy keeps every placeholder used by its English counterpart', () => {
    const en = getShareCopy('en');
    const de = getShareCopy('de');
    expect(de.modalTitle).toBe('Dosierungsdaten teilen');
    for (const key of Object.keys(en) as (keyof ShareCopy)[]) {
        expect(de[key].trim(), key).toBeTruthy();
        expect(placeholders(de[key]), key).toEqual(placeholders(en[key]));
    }
});
