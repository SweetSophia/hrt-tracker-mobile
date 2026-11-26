import { appLocale } from '../../i18n/locale';
import { parseRecordDecimal } from '../../utils/recordDecimal';

/** Connect a format error or refused amount to the message below the fields. */
export const refusedFieldProps = (value: string, invalid?: boolean, errorId?: string, optional = false) => {
    const parsed = parseRecordDecimal(value, appLocale() ?? 'en-US');
    if (parsed.kind === 'invalid' || (invalid && !optional && (parsed.kind === 'empty' || parsed.value <= 0))) {
        return { 'aria-invalid': true as const, 'aria-describedby': errorId };
    }
    return {};
};
