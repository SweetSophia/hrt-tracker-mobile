import { describe, expect, it } from 'vitest';
import { formatRecordDecimal, parseRecordDecimal } from '../src/utils/recordDecimal';

describe('record decimal entry', () => {
    it.each([
        ['ru-RU', '1,5', 1.5],
        ['en-US', '1.5', 1.5],
        ['en-US', '1,5', 1.5],
        ['ru-RU', '1.234', 1.234],
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
        ['de-DE', '1.234'],
        ['tr-TR', '12.345'],
        ['en-US', '1.2,3'],
        ['en-US', '1,234,567'],
        ['ru-RU', '1 234,5'],
        ['ru-RU', '1,'],
        ['en-US', '-'],
        ['en-US', '1e'],
        ['en-US', '1e999'],
        ['en-US', 'Infinity'],
        ['en-US', '1.5 mg'],
    ])('rejects %s input %s as invalid', (locale, input) => {
        expect(parseRecordDecimal(input, locale)).toEqual({ kind: 'invalid' });
    });

    it('distinguishes an omitted amount from malformed input', () => {
        expect(parseRecordDecimal(' ', 'ru-RU')).toEqual({ kind: 'empty' });
        expect(parseRecordDecimal(',', 'ru-RU')).toEqual({ kind: 'invalid' });
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
