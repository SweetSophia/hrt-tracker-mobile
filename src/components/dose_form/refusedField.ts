import { parseRecordDecimal } from '../../utils/recordDecimal';

/** Connect a format error or refused amount to the message below the fields. */
export const refusedFieldProps = (
    value: string,
    locale: string,
    refused?: boolean,
    errorId?: string,
    optional = false,
) => {
    const parsed = parseRecordDecimal(value, locale);
    const missingOrNonPositive = parsed.kind === 'empty' || (parsed.kind === 'number' && parsed.value <= 0);
    if (
        parsed.kind === 'invalid' ||
        (refused && (parsed.kind === 'incomplete' || (!optional && missingOrNonPositive)))
    ) {
        return { 'aria-invalid': true as const, 'aria-describedby': errorId };
    }
    return {};
};
