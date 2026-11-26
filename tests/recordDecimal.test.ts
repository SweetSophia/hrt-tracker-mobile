import { describe, expect, it, vi } from 'vitest';
import { Ester, Route } from '../logic';
import * as locale from '../src/i18n/locale';
import { sinceDoseLabel } from '../src/utils/labReport';
import {
    formatRecordDecimal,
    formatRecordPercent,
    formatRecordSummary,
    parseRecordDecimal,
} from '../src/utils/recordDecimal';
import { frequencyLabel, regimenLabel } from '../src/utils/regimenText';

describe('record decimal entry', () => {
    it.each([
        ['ru-RU', '1,5', 1.5],
        ['en-US', '1.5', 1.5],
        ['en-US', '1,5', 1.5],
        ['ru-RU', '1.234', 1.234],
        ['ru-RU', '1,234', 1.234],
        ['uk-UA', '1.234e-5', 1.234e-5],
        ['tr-TR', ',5', 0.5],
        ['de-DE', '0.125', 0.125],
        ['de-DE', '1,234', 1.234],
        ['en-US', '1.234', 1.234],
        ['en-US', ' 42 ', 42],
        ['en-US', '0', 0],
        ['en-US', '-1.5', -1.5],
        ['ru-RU', '1,5e-7', 1.5e-7],
        ['en-US', '1e+3', 1000],
    ])('reads %s input %s as %s', (locale, input, value) => {
        expect(parseRecordDecimal(input, locale)).toEqual({ kind: 'number', value });
    });

    it.each([
        ['en-US', '1,234'],
        ['en-US', '1,234e5'],
        ['de-DE', '1.234'],
        ['tr-TR', '12.345'],
        ['tr-TR', '1.234e-5'],
        ['en-US', '1.2,3'],
        ['en-US', '1,234,567'],
        ['ru-RU', '1 234,5'],
        ['en-US', '1e999'],
        ['en-US', 'Infinity'],
        ['en-US', '1.5 mg'],
    ])('rejects %s input %s as invalid', (locale, input) => {
        expect(parseRecordDecimal(input, locale)).toEqual({ kind: 'invalid' });
    });

    it.each(['0,', '.', ',', '-', '1e', '1,5e-', '1.5e+'])('recognizes %s as unfinished entry', input => {
        expect(parseRecordDecimal(input, 'ru-RU')).toEqual({ kind: 'incomplete' });
    });

    it('keeps a blank amount separate from unfinished or malformed input', () => {
        expect(parseRecordDecimal(' ', 'ru-RU')).toEqual({ kind: 'empty' });
    });

    it('keeps summary precision with a German decimal comma', () => {
        expect(formatRecordSummary(34.125, 'de-DE')).toBe('34,125');
        expect(formatRecordSummary('2.50', 'de')).toBe('2,50');
    });

    it('uses canonical summary notation when no locale is available', () => {
        expect(formatRecordSummary('2.50')).toBe('2.50');
        expect(formatRecordPercent(85, undefined)).toBe('85%');
    });

    it('keeps German percentage spacing consistent across summaries', () => {
        expect(formatRecordPercent('5', 'de-DE')).toBe('5\u00a0%');
        expect(formatRecordPercent(85, 'de')).toBe('85\u00a0%');
        expect(formatRecordPercent(85, 'en-US')).toBe('85%');
    });

    it('formats German amounts and intervals in Plan and Forecast', () => {
        const current = vi.spyOn(locale, 'appLocale').mockReturnValue('de-DE');
        const strings: Record<string, string> = { 'regimen.every_days': 'alle {n} Tage' };
        const t = (key: string) => strings[key] ?? key;
        try {
            const regimen = { ester: Ester.EV, route: Route.oral, doseMG: 2.5, extras: {} };
            expect(regimenLabel(regimen, t)).toContain('2,5 mg');
            expect(frequencyLabel({ everyDays: 3.5, timesPerDay: 1 }, t)).toContain('3,5 Tage');
        } finally {
            current.mockRestore();
        }
    });

    it('uses German decimal commas for a draw time relative to the dose', () => {
        expect(sinceDoseLabel(4.1, () => '{n} h', 'de-DE')).toBe('4,1 h');
    });

    it.each([
        ['ru-RU', 1.234, '1,234'],
        ['de-DE', 0.0375, '0,0375'],
        ['en-US', 1e-7, '1e-7'],
        ['ru-RU', 1.234e-7, '1,234e-7'],
        ['en-US', 1234.75, '1234.75'],
    ])('opens a previously saved number in %s with all editable precision', (locale, value, input) => {
        expect(formatRecordDecimal(value, locale)).toBe(input);
        expect(parseRecordDecimal(input, locale)).toEqual({ kind: 'number', value });
    });
});
