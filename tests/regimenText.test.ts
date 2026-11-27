import { afterEach, expect, it, vi } from 'vitest';
import { Ester, ExtraKey, Route } from '../src/domain/types';
import * as locale from '../src/i18n/locale';
import { TRANSLATIONS } from '../src/i18n/translations';
import { planItemLabel, regimenLabel, supplyLabel } from '../src/utils/regimenText';

afterEach(() => vi.restoreAllMocks());

it.each([
    ['en', Route.injection, 'Estradiol injection'],
    ['en', Route.oral, 'Oral estradiol'],
    ['en', Route.sublingual, 'Sublingual estradiol'],
    ['de', Route.injection, 'Estradiol zur Injektion'],
    ['de', Route.gel, 'Estradiol als Gel'],
    ['de', Route.patchApply, 'Estradiol als Pflaster'],
    ['de', Route.pellet, 'Estradiol als Pellet'],
    ['de', Route.oral, 'Estradiol zum Einnehmen'],
    ['de', Route.sublingual, 'Estradiol zur sublingualen Anwendung'],
    ['zh', Route.oral, '口服雌二醇'],
    ['zh', Route.sc, '雌二醇皮下注射'],
    ['zh-TW', Route.oral, '口服雌二醇'],
    ['zh-TW', Route.nasal, '雌二醇鼻噴'],
    ['yue', Route.oral, '口服雌二醇'],
    ['yue', Route.nasal, '雌二醇噴鼻劑'],
    ['ja', Route.oral, '経口エストラジオール'],
    ['ja', Route.nasal, 'エストラジオール点鼻'],
    ['ko', Route.oral, '경구 에스트라디올'],
    ['ko', Route.nasal, '에스트라디올 비강 스프레이'],
    ['ru', Route.sc, 'Эстрадиол для подкожных инъекций'],
    ['uk', Route.nasal, 'Естрадіол у вигляді назального спрею'],
    ['tr', Route.oral, 'Ağızdan östradiol'],
] as const)('shows the same %s drug and %s form in Supplies and on Overview', (lang, route, expected) => {
    vi.spyOn(locale, 'appLocale').mockReturnValue(lang);
    const pack: Record<string, string> = TRANSLATIONS[lang];
    const t = (key: string) => pack[key] ?? key;
    const item = { id: 'target', ester: Ester.E2, route };
    const other = { id: 'other', ester: Ester.E2, route: route === Route.oral ? Route.sublingual : Route.oral };

    expect(supplyLabel(item, t)).toBe(expected);
    expect(planItemLabel(item, [other, item], t)).toBe(expected);
});

it('keeps a German route name usable on its own and inflects it alongside a dose', () => {
    vi.spyOn(locale, 'appLocale').mockReturnValue('de');
    const pack: Record<string, string> = TRANSLATIONS.de;
    const t = (key: string) => pack[key] ?? key;
    expect(t('regimen.route.injection')).toBe('Injektion');
    expect(regimenLabel({ ester: Ester.EV, route: Route.injection, doseMG: 2.5, extras: {} }, t)).toBe(
        'Estradiolvalerat 2,5 mg zur Injektion',
    );
    const patch = {
        ester: Ester.E2,
        route: Route.patchApply,
        doseMG: 0,
        extras: { [ExtraKey.releaseRateUGPerDay]: 37.5 },
    };
    expect(regimenLabel(patch, t)).toBe('Estradiol als Pflaster 37,5 µg/Tag');
});

it('separates an imported Latin drug code from adjacent Chinese text on either side', () => {
    vi.spyOn(locale, 'appLocale').mockReturnValue('zh');
    const pack: Record<string, string> = TRANSLATIONS.zh;
    const t = (key: string) => pack[key] ?? key;
    const ester = 'NewDrug' as Ester;
    expect(supplyLabel({ ester, route: Route.oral }, t)).toBe('口服 NewDrug');
    expect(supplyLabel({ ester, route: Route.gel }, t)).toBe('NewDrug 凝胶');
    expect(regimenLabel({ ester, route: Route.oral, doseMG: 2.5, extras: {} }, t)).toBe('口服 NewDrug 2.5 mg');
});

it('uses the localized event name for a patch removal in an imported plan', () => {
    const pack: Record<string, string> = TRANSLATIONS.de;
    expect(supplyLabel({ ester: Ester.E2, route: Route.patchRemove }, key => pack[key] ?? key)).toBe(
        'Estradiol (Pflaster entfernen)',
    );
});

it('keeps the short drug name on Overview when the plan has no ambiguity', () => {
    const pack: Record<string, string> = TRANSLATIONS.en;
    const nasal = { id: 'nasal', route: Route.nasal, ester: Ester.E2 };
    const tablet = { id: 'tablet', route: Route.oral, ester: Ester.EV };

    expect(planItemLabel(nasal, [tablet, nasal], key => pack[key] ?? key)).toBe('Estradiol');
});
