import { expect, it } from 'vitest';
import { Route } from '../src/domain/types';
import { LANG_CODES } from '../src/i18n/languages';
import { TRANSLATIONS } from '../src/i18n/translations';
import { fill } from '../src/utils/regimenText';

const importedRoutes: Route[] = [Route.sc, Route.nasal, Route.pellet, Route.patchRemove];

it.each(LANG_CODES)('labels every route accepted in a saved plan in %s', lang => {
    const pack: Record<string, string> = TRANSLATIONS[lang];
    const en: Record<string, string> = TRANSLATIONS.en;
    for (const route of Object.values(Route)) {
        for (const prefix of ['plan.done', 'plan.verb']) {
            const key = `${prefix}.${route}`;
            const label = pack[key]?.trim();
            expect(label, key).toBeTruthy();
            expect(label, key).not.toBe(key);
            if (lang !== 'en' && importedRoutes.includes(route)) expect(label, key).not.toBe(en[key]);
        }
    }
});

it.each([
    ['zh', Route.sc, '今天打过了', '打了'],
    ['zh-TW', Route.nasal, '今天噴過了', '噴了'],
    ['yue', Route.pellet, '今日植入咗喇', '植入咗'],
    ['zh', Route.patchRemove, '今天取下过了', '取下了'],
] as const)('uses the local verb and completion label for %s %s', (lang, route, status, done) => {
    const pack = TRANSLATIONS[lang];
    expect(fill(pack['plan.taken'], { verb: pack[`plan.verb.${route}`] })).toBe(status);
    expect(pack[`plan.done.${route}`]).toBe(done);
});
