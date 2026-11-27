import { afterEach, expect, it, vi } from 'vitest';
import { Ester, Route } from '../src/domain/types';
import * as locale from '../src/i18n/locale';
import { TRANSLATIONS } from '../src/i18n/translations';
import { planItemLabel, supplyLabel } from '../src/utils/regimenText';

afterEach(() => vi.restoreAllMocks());

it.each([
    ['en', Route.injection, 'Estradiol injection'],
    ['de', Route.injection, 'Estradiol zur Injektion'],
    ['de', Route.gel, 'Estradiol als Gel'],
    ['de', Route.patchApply, 'Estradiol als Pflaster'],
    ['zh', Route.sc, '雌二醇皮下注射'],
    ['zh-TW', Route.nasal, '雌二醇鼻噴'],
    ['yue', Route.nasal, '雌二醇噴鼻劑'],
    ['ja', Route.nasal, 'エストラジオール点鼻'],
    ['ko', Route.nasal, '에스트라디올 비강 스프레이'],
] as const)('shows the same %s drug and %s form in Supplies and on Overview', (lang, route, expected) => {
    vi.spyOn(locale, 'appLocale').mockReturnValue(lang);
    const pack: Record<string, string> = TRANSLATIONS[lang];
    const t = (key: string) => pack[key] ?? key;
    const item = { id: 'target', ester: Ester.E2, route };
    const oral = { id: 'oral', ester: Ester.E2, route: Route.oral };

    expect(supplyLabel(item, t)).toBe(expected);
    expect(planItemLabel(item, [oral, item], t)).toBe(expected);
});

it('keeps the short drug name on Overview when the plan has no ambiguity', () => {
    const pack: Record<string, string> = TRANSLATIONS.en;
    const nasal = { id: 'nasal', route: Route.nasal, ester: Ester.E2 };
    const tablet = { id: 'tablet', route: Route.oral, ester: Ester.EV };

    expect(planItemLabel(nasal, [tablet, nasal], key => pack[key] ?? key)).toBe('Estradiol');
});
