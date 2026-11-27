import { afterEach, expect, it, vi } from 'vitest';
import { Ester, ExtraKey, Route } from '../src/domain/types';
import * as locale from '../src/i18n/locale';
import { LANG_CODES, type Lang } from '../src/i18n/languages';
import { TRANSLATIONS } from '../src/i18n/translations';
import { planItemLabel, regimenLabel, supplyLabel } from '../src/utils/regimenText';

afterEach(() => vi.restoreAllMocks());

type AdministrationRoute = Exclude<Route, Route.patchRemove>;

const ADMINISTRATION_ROUTES = Object.values(Route).filter(
    (route): route is AdministrationRoute => route !== Route.patchRemove,
);

// Expected labels are independent of the translation templates used by the app.
const EXPECTED_FORM: Record<Lang, Record<AdministrationRoute, string>> = {
    zh: {
        [Route.injection]: '雌二醇肌肉注射',
        [Route.sc]: '雌二醇皮下注射',
        [Route.nasal]: '雌二醇鼻喷',
        [Route.pellet]: '雌二醇皮下埋植',
        [Route.oral]: '口服雌二醇',
        [Route.sublingual]: '舌下雌二醇',
        [Route.gel]: '雌二醇凝胶',
        [Route.patchApply]: '雌二醇贴片',
    },
    'zh-TW': {
        [Route.injection]: '雌二醇肌肉注射',
        [Route.sc]: '雌二醇皮下注射',
        [Route.nasal]: '雌二醇鼻噴',
        [Route.pellet]: '雌二醇皮下植入',
        [Route.oral]: '口服雌二醇',
        [Route.sublingual]: '舌下雌二醇',
        [Route.gel]: '雌二醇凝膠',
        [Route.patchApply]: '雌二醇貼片',
    },
    yue: {
        [Route.injection]: '雌二醇肌肉注射',
        [Route.sc]: '雌二醇皮下注射',
        [Route.nasal]: '雌二醇噴鼻劑',
        [Route.pellet]: '雌二醇皮下植入劑',
        [Route.oral]: '口服雌二醇',
        [Route.sublingual]: '舌下雌二醇',
        [Route.gel]: '雌二醇凝膠',
        [Route.patchApply]: '雌二醇貼片',
    },
    en: {
        [Route.injection]: 'Estradiol injection',
        [Route.sc]: 'Estradiol subcutaneous injection',
        [Route.nasal]: 'Estradiol nasal spray',
        [Route.pellet]: 'Estradiol pellet',
        [Route.oral]: 'Oral estradiol',
        [Route.sublingual]: 'Sublingual estradiol',
        [Route.gel]: 'Estradiol gel',
        [Route.patchApply]: 'Estradiol patch',
    },
    de: {
        [Route.injection]: 'Estradiol zur Injektion',
        [Route.sc]: 'Estradiol zur subkutanen Injektion',
        [Route.nasal]: 'Estradiol als Nasenspray',
        [Route.pellet]: 'Estradiol als Pellet',
        [Route.oral]: 'Estradiol zum Einnehmen',
        [Route.sublingual]: 'Estradiol zur sublingualen Anwendung',
        [Route.gel]: 'Estradiol als Gel',
        [Route.patchApply]: 'Estradiol als Pflaster',
    },
    ja: {
        [Route.injection]: 'エストラジオール筋注',
        [Route.sc]: 'エストラジオール皮下注射',
        [Route.nasal]: 'エストラジオール点鼻',
        [Route.pellet]: 'エストラジオールペレット',
        [Route.oral]: '経口エストラジオール',
        [Route.sublingual]: '舌下エストラジオール',
        [Route.gel]: 'エストラジオールジェル',
        [Route.patchApply]: 'エストラジオールパッチ',
    },
    ko: {
        [Route.injection]: '에스트라디올 주사',
        [Route.sc]: '에스트라디올 피하 주사',
        [Route.nasal]: '에스트라디올 비강 스프레이',
        [Route.pellet]: '에스트라디올 펠릿',
        [Route.oral]: '경구 에스트라디올',
        [Route.sublingual]: '설하 에스트라디올',
        [Route.gel]: '에스트라디올 젤',
        [Route.patchApply]: '에스트라디올 패치',
    },
    tr: {
        [Route.injection]: 'Östradiol (kas içi enjeksiyon)',
        [Route.sc]: 'Östradiol (deri altı enjeksiyon)',
        [Route.nasal]: 'Östradiol burun spreyi',
        [Route.pellet]: 'Östradiol pelet',
        [Route.oral]: 'Ağızdan östradiol',
        [Route.sublingual]: 'Dil altı östradiol',
        [Route.gel]: 'Östradiol jel',
        [Route.patchApply]: 'Östradiol yama',
    },
    ru: {
        [Route.injection]: 'Эстрадиол для внутримышечных инъекций',
        [Route.sc]: 'Эстрадиол для подкожных инъекций',
        [Route.nasal]: 'Эстрадиол в виде назального спрея',
        [Route.pellet]: 'Эстрадиол в виде имплантата',
        [Route.oral]: 'Эстрадиол для перорального применения',
        [Route.sublingual]: 'Эстрадиол для сублингвального применения',
        [Route.gel]: 'Эстрадиол в виде геля',
        [Route.patchApply]: 'Эстрадиол в виде пластыря',
    },
    uk: {
        [Route.injection]: 'Естрадіол для внутрішньом’язових ін’єкцій',
        [Route.sc]: 'Естрадіол для підшкірних ін’єкцій',
        [Route.nasal]: 'Естрадіол у вигляді назального спрею',
        [Route.pellet]: 'Естрадіол у вигляді імплантату',
        [Route.oral]: 'Естрадіол для перорального застосування',
        [Route.sublingual]: 'Естрадіол для сублінгвального застосування',
        [Route.gel]: 'Естрадіол у вигляді гелю',
        [Route.patchApply]: 'Естрадіол у вигляді пластиру',
    },
};

const EXPECTED_WITH_DOSE: { lang: Lang; expected: string }[] = [
    { lang: 'zh', expected: '口服雌二醇 2 mg' },
    { lang: 'ja', expected: '経口エストラジオール 2 mg' },
    { lang: 'de', expected: 'Estradiol 2 mg zum Einnehmen' },
    { lang: 'ru', expected: 'Эстрадиол 2 mg для перорального применения' },
    { lang: 'uk', expected: 'Естрадіол 2 mg для перорального застосування' },
];

const CASES = LANG_CODES.flatMap(lang =>
    ADMINISTRATION_ROUTES.map(route => ({ lang, route, expected: EXPECTED_FORM[lang][route] })),
);

it.each(CASES)('names the $lang $route form the same in Supplies and on Overview', ({ lang, route, expected }) => {
    vi.spyOn(locale, 'appLocale').mockReturnValue(lang);
    const pack: Record<string, string> = TRANSLATIONS[lang];
    const t = (key: string) => pack[key] ?? key;
    const item = { id: 'target', ester: Ester.E2, route };
    const other = {
        id: 'other',
        ester: Ester.E2,
        route: route === Route.oral ? Route.sublingual : Route.oral,
    };

    expect(supplyLabel(item, t)).toBe(expected);
    expect(planItemLabel(item, [other, item], t)).toBe(expected);
});

it.each(EXPECTED_WITH_DOSE)('puts the dose in its expected place in the $lang prescription', ({ lang, expected }) => {
    vi.spyOn(locale, 'appLocale').mockReturnValue(lang);
    const pack: Record<string, string> = TRANSLATIONS[lang];
    const t = (key: string) => pack[key] ?? key;

    expect(regimenLabel({ ester: Ester.E2, route: Route.oral, doseMG: 2, extras: {} }, t)).toBe(expected);
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

it.each([
    '{drug} und {drug}{dose}',
    '{drug}{dose} oder {dose}',
    '{drug} {drug}',
    '{dose} {dose}',
    '{drug} zur Injektion',
    '{dose} zur Injektion',
    '{drug}{dose} {unknown}',
])('keeps the drug, route and dose when a translation is malformed: %s', pattern => {
    const pack: Record<string, string> = TRANSLATIONS.de;
    const t = (key: string) => (key === 'regimen.form.injection' ? pattern : (pack[key] ?? key));
    const item = { route: Route.injection, ester: Ester.E2, doseMG: 2.5, extras: {} };
    vi.spyOn(locale, 'appLocale').mockReturnValue('de');
    expect(supplyLabel(item, t)).toBe('Estradiol (Injektion)');
    expect(regimenLabel(item, t)).toBe('Estradiol 2,5 mg (Injektion)');
});
