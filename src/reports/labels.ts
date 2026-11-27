/**
 * The words the report and the options screen use for one record.
 *
 * These live outside the PDF renderer because the options list names the
 * medications the same way the finished report does: a reader who picked
 * "Oral estradiol" has to find "Oral estradiol" in the table, in every
 * language, with the same drug and the same form.
 *
 * Pure and free of the PDF library, so a screen can import it without pulling
 * the renderer in.
 */
import { ExtraKey, Route, isT_LabUnit, type DoseEvent, type LabResult } from '../../logic';
import type { Lang } from '../i18n/languages';
import { LOCALE_MAP } from '../utils/helpers';
import { clinicalUnit } from '../utils/clinicalUnit';
import { formatRecordDecimal } from '../utils/recordDecimal';
import { supplyLabel } from '../utils/regimenText';

export type T = (key: string) => string;

/** The locale the report follows: the app's language, as the app maps it. */
export const reportLocale = (lang: Lang): string => LOCALE_MAP[lang] ?? 'en-US';

/**
 * Formatters are built once per language and kept. A report prints thousands of
 * dates and numbers, and `toLocaleDateString` rebuilds an ICU formatter on every
 * call.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A new report follows the device's current timezone, including after travel. */
export const resetReportDateFormatters = (): void => formatters.clear();

const formatter = (lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
    const key = lang + '|' + JSON.stringify(options);
    let found = formatters.get(key);
    if (!found) {
        found = new Intl.DateTimeFormat(reportLocale(lang), options);
        formatters.set(key, found);
    }
    return found;
};

/** A day with its year: "1 Jan 2026". For a table cell or a heading. */
export const formatDay = (lang: Lang, date: Date): string =>
    Number.isNaN(date.getTime())
        ? ''
        : formatter(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);

/** A day without its year: "1 Jan". For a chart axis, where the year sits in the caption. */
export const formatDayShort = (lang: Lang, date: Date): string =>
    Number.isNaN(date.getTime()) ? '' : formatter(lang, { month: 'short', day: 'numeric' }).format(date);

/**
 * A moment of the day: "08:15". The clock is 24-hour everywhere, because a
 * report read by someone else should not have to guess whether 2 pm was
 * written as 2 or 14.
 */
export const formatTime = (lang: Lang, date: Date): string =>
    Number.isNaN(date.getTime())
        ? ''
        : formatter(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

/**
 * A day and the time on it: "4 Feb 2026 08:15".
 *
 * A report that lists doses has to say when each one was taken: a person can
 * take two doses on the same day, and a blood draw can share a day with
 * another one. The date alone cannot tell the rows apart.
 */
export const formatDayTime = (lang: Lang, date: Date): string => {
    const day = formatDay(lang, date);
    const time = formatTime(lang, date);
    if (!day) return time;
    return time ? day + ' ' + time : day;
};

/**
 * A calendar day written "YYYY-MM-DD" is read at midday, so a daylight-saving
 * jump never moves it into the day before or after.
 */
export const parseCalendarDay = (day: string): Date => {
    const [year, month, date] = day.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return new Date(NaN);
    return new Date(year, month - 1, date, 12, 0, 0, 0);
};

/** The day a moment falls on, in the reader's own timezone. */
export const localDate = (timeH: number): Date => new Date(timeH * 3600000);

/**
 * A recorded dose, with every decimal it was stored with: "0.125 mg", not
 * "0.13 mg".
 *
 * A dose rounded on the way to the page is a dose the reader cannot check,
 * and a dose of 0.004 mg rounded to two decimals reads as no dose at all. The
 * separator is the language's, the same as every other number in the report.
 */
export const formatDoseNumber = (lang: Lang, value: number): string => formatRecordDecimal(value, reportLocale(lang));

/**
 * A measured value keeps every decimal it was recorded with. A lab result is
 * the one number in a report that must not be rounded: "0.37 pg/mL" and
 * "0.4 pg/mL" are different findings.
 */
export const formatLabNumber = (lang: Lang, value: number): string => formatRecordDecimal(value, reportLocale(lang));

/** A number on an axis: a round value, written the way the language writes it. */
export const formatTickNumber = (lang: Lang, value: number): string =>
    formatRecordDecimal(Number(value.toPrecision(12)), reportLocale(lang));

/**
 * A measured value on a chart: enough digits to be useful, and a tilde when
 * the digits are not the whole value.
 *
 * A tilde rather than the "≈" sign: the Latin subset of the report's font
 * carries no such glyph, and a report that marked approximations in one
 * language and not in another would be worse than either.
 */
export const formatPointValue = (lang: Lang, value: number): string => {
    const precise = Number(value.toPrecision(4));
    const text = formatRecordDecimal(precise, reportLocale(lang));
    return precise === value ? text : '~' + text;
};

/**
 * The route a patch event is about: a removal names the patch it took off, so
 * the medication list groups it with the application it belongs to.
 */
const medicationRoute = (event: DoseEvent): Route =>
    event.route === Route.patchRemove ? Route.patchApply : event.route;

/**
 * The medication a dose belongs to, in the language's own words: "Oral
 * estradiol", "雌二醇凝胶". The same phrase the options list offers, so the
 * table and the selection the reader made read alike.
 */
export const medicationLabel = (event: DoseEvent, t: T): string =>
    supplyLabel({ route: medicationRoute(event), ester: event.ester }, t);

/**
 * How the dose was taken. A removal has no form of its own: the route names
 * it, the way the history list names it.
 */
export const routeLabel = (event: DoseEvent, t: T): string => {
    if (event.route === Route.patchRemove) return t('route.patchRemove');
    const key = 'regimen.route.' + event.route;
    const standalone = t(key);
    return standalone === key ? t('route.' + event.route) : standalone;
};

/**
 * The amount: milligrams for most routes, the daily release rate for a patch
 * (the amount a patch carries is not the amount the body sees), and nothing at
 * all for a removal, which has no amount of its own. A dose of zero is still a
 * dose, and says so.
 */
export const doseLabel = (event: DoseEvent, lang: Lang, t: T): string => {
    if (event.route === Route.patchRemove) return '—';
    const rate = event.extras?.[ExtraKey.releaseRateUGPerDay];
    if (event.route === Route.patchApply && typeof rate === 'number' && rate > 0) {
        return formatDoseNumber(lang, rate) + ' µg' + t('regimen.per_day');
    }
    return formatDoseNumber(lang, event.doseMG) + ' mg';
};

/** The hormone a lab result measured, from the unit it was reported in. */
export const labHormone = (lab: LabResult): 'E2' | 'T' => (isT_LabUnit(lab.unit) ? 'T' : 'E2');

/**
 * The measured value and the unit it was reported in. The unit stays the one
 * the lab used: a value in pmol/L is not silently turned into pg/mL, because
 * the two are not the same number and the reader has to know which one this is.
 */
export const labValueLabel = (lab: LabResult, lang: Lang): string => formatLabNumber(lang, lab.concValue);

export const labUnitLabel = (lab: LabResult): string => clinicalUnit(lab.unit);

/** The label a hormone goes by in the report. */
export const hormoneLabel = (hormone: 'E2' | 'T', t: T): string =>
    t(hormone === 'T' ? 'report.testosterone' : 'report.estradiol');
