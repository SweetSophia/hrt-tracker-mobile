import type { Route } from '../domain/types';
import type { Lang } from './languages';

// This type requires a {drug} before a {dose}. The pack test in tests/translations.test.ts and
// formatDrugForm in src/utils/regimenText.ts also require exactly one of each and reject other placeholders.
type RegimenForms = Record<
    `regimen.form.${Exclude<Route, Route.patchRemove>}`,
    `${string}{drug}${string}{dose}${string}`
>;

const ZH_TW_FORMS: RegimenForms = {
    'regimen.form.injection': '{drug}肌肉注射{dose}',
    'regimen.form.sc': '{drug}皮下注射{dose}',
    'regimen.form.nasal': '{drug}鼻噴{dose}',
    'regimen.form.pellet': '{drug}皮下植入{dose}',
    'regimen.form.oral': '口服{drug}{dose}',
    'regimen.form.sublingual': '舌下{drug}{dose}',
    'regimen.form.gel': '{drug}凝膠{dose}',
    'regimen.form.patchApply': '{drug}貼片{dose}',
};

/**
 * Use {drug} before {dose}, once each. The optional dose supplies its own leading space.
 * Place the route before, between or after those slots to suit the language.
 * Plan and Forecast pickers use the standalone names under regimen.route.* in the language packs.
 */
export const REGIMEN_FORMS: Record<Lang, RegimenForms> = {
    zh: {
        'regimen.form.injection': '{drug}肌肉注射{dose}',
        'regimen.form.sc': '{drug}皮下注射{dose}',
        'regimen.form.nasal': '{drug}鼻喷{dose}',
        'regimen.form.pellet': '{drug}皮下埋植{dose}',
        'regimen.form.oral': '口服{drug}{dose}',
        'regimen.form.sublingual': '舌下{drug}{dose}',
        'regimen.form.gel': '{drug}凝胶{dose}',
        'regimen.form.patchApply': '{drug}贴片{dose}',
    },

    'zh-TW': ZH_TW_FORMS,

    yue: {
        ...ZH_TW_FORMS,
        'regimen.form.nasal': '{drug}噴鼻劑{dose}',
        'regimen.form.pellet': '{drug}皮下植入劑{dose}',
    },

    en: {
        'regimen.form.injection': '{drug}{dose} injection',
        'regimen.form.sc': '{drug}{dose} subcutaneous injection',
        'regimen.form.nasal': '{drug}{dose} nasal spray',
        'regimen.form.pellet': '{drug}{dose} pellet',
        'regimen.form.oral': 'Oral {drug}{dose}',
        'regimen.form.sublingual': 'Sublingual {drug}{dose}',
        'regimen.form.gel': '{drug}{dose} gel',
        'regimen.form.patchApply': '{drug}{dose} patch',
    },

    de: {
        'regimen.form.injection': '{drug}{dose} zur Injektion',
        'regimen.form.sc': '{drug}{dose} zur subkutanen Injektion',
        'regimen.form.nasal': '{drug}{dose} als Nasenspray',
        'regimen.form.pellet': '{drug}{dose} als Pellet',
        'regimen.form.oral': '{drug}{dose} zum Einnehmen',
        'regimen.form.sublingual': '{drug}{dose} zur sublingualen Anwendung',
        'regimen.form.gel': '{drug}{dose} als Gel',
        'regimen.form.patchApply': '{drug}{dose} als Pflaster',
    },

    ja: {
        'regimen.form.injection': '{drug}筋注{dose}',
        'regimen.form.sc': '{drug}皮下注射{dose}',
        'regimen.form.nasal': '{drug}点鼻{dose}',
        'regimen.form.pellet': '{drug}ペレット{dose}',
        'regimen.form.oral': '経口{drug}{dose}',
        'regimen.form.sublingual': '舌下{drug}{dose}',
        'regimen.form.gel': '{drug}ジェル{dose}',
        'regimen.form.patchApply': '{drug}パッチ{dose}',
    },

    ko: {
        'regimen.form.injection': '{drug} 주사{dose}',
        'regimen.form.sc': '{drug} 피하 주사{dose}',
        'regimen.form.nasal': '{drug} 비강 스프레이{dose}',
        'regimen.form.pellet': '{drug} 펠릿{dose}',
        'regimen.form.oral': '경구 {drug}{dose}',
        'regimen.form.sublingual': '설하 {drug}{dose}',
        'regimen.form.gel': '{drug} 젤{dose}',
        'regimen.form.patchApply': '{drug} 패치{dose}',
    },

    tr: {
        'regimen.form.injection': '{drug}{dose} (kas içi enjeksiyon)',
        'regimen.form.sc': '{drug}{dose} (deri altı enjeksiyon)',
        'regimen.form.nasal': '{drug}{dose} burun spreyi',
        'regimen.form.pellet': '{drug}{dose} pelet',
        'regimen.form.oral': 'Ağızdan {drug}{dose}',
        'regimen.form.sublingual': 'Dil altı {drug}{dose}',
        'regimen.form.gel': '{drug}{dose} jel',
        'regimen.form.patchApply': '{drug}{dose} yama',
    },

    ru: {
        'regimen.form.injection': '{drug}{dose} для внутримышечных инъекций',
        'regimen.form.sc': '{drug}{dose} для подкожных инъекций',
        'regimen.form.nasal': '{drug}{dose} в виде назального спрея',
        'regimen.form.pellet': '{drug}{dose} в виде имплантата',
        'regimen.form.oral': '{drug}{dose} для перорального применения',
        'regimen.form.sublingual': '{drug}{dose} для сублингвального применения',
        'regimen.form.gel': '{drug}{dose} в виде геля',
        'regimen.form.patchApply': '{drug}{dose} в виде пластыря',
    },

    uk: {
        'regimen.form.injection': '{drug}{dose} для внутрішньом’язових ін’єкцій',
        'regimen.form.sc': '{drug}{dose} для підшкірних ін’єкцій',
        'regimen.form.nasal': '{drug}{dose} у вигляді назального спрею',
        'regimen.form.pellet': '{drug}{dose} у вигляді імплантату',
        'regimen.form.oral': '{drug}{dose} для перорального застосування',
        'regimen.form.sublingual': '{drug}{dose} для сублінгвального застосування',
        'regimen.form.gel': '{drug}{dose} у вигляді гелю',
        'regimen.form.patchApply': '{drug}{dose} у вигляді пластиру',
    },
};
