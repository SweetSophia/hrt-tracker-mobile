export type RecordDecimal = { kind: 'empty' } | { kind: 'invalid' } | { kind: 'number'; value: number };

type NumberSeparators = { decimal: '.' | ','; group?: string };

const separators = new Map<string, NumberSeparators>();
const completeNumber = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[+-]?\d+)?$/i;
const possibleGrouping = /^[+-]?[1-9]\d{0,2}[.,]\d{3}$/;

function numberSeparators(locale: string): NumberSeparators {
    const cached = separators.get(locale);
    if (cached) return cached;
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    const result: NumberSeparators = {
        decimal: parts.find(part => part.type === 'decimal')?.value === ',' ? ',' : '.',
        group: parts.find(part => part.type === 'group')?.value,
    };
    separators.set(locale, result);
    return result;
}

export function parseRecordDecimal(text: string, locale: string): RecordDecimal {
    const input = text.trim();
    if (!input) return { kind: 'empty' };
    if (!completeNumber.test(input)) return { kind: 'invalid' };

    const { decimal, group } = numberSeparators(locale);
    // An alternate mark can be a decimal from a different keyboard, or the
    // current locale's grouping mark. Ask the user to clarify ambiguous text.
    if (group && group !== decimal && input.includes(group) && possibleGrouping.test(input)) {
        return { kind: 'invalid' };
    }

    const value = Number(input.replace(',', '.'));
    return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'invalid' };
}

/** Keep the stored number's precision and never add group separators. */
export function formatRecordDecimal(value: number, locale: string): string {
    return String(value).replace('.', numberSeparators(locale).decimal);
}

/** For previews and controls that only need a complete number. */
export function recordDecimalValue(text: string, locale: string): number {
    const parsed = parseRecordDecimal(text, locale);
    return parsed.kind === 'number' ? parsed.value : NaN;
}
