export type DoseErrorField = 'raw' | 'equivalent' | 'patchRate' | 'patchWear' | 'hold';

/** Connect the field that needs correction to the message below the fields. */
export const refusedFieldProps = (invalid: boolean, errorId?: string) =>
    invalid ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
