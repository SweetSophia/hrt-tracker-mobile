import React from 'react';
import { Minus, Plus } from './icons';
import { formatRecordDecimal, recordDecimalValue } from '../utils/recordDecimal';

/**
 * A number field with − and + on either side, so the batch values can be
 * nudged with a thumb instead of summoning the number pad. Typing still works;
 * the buttons step from whatever is typed and stop at the limits.
 */
const Stepper: React.FC<{
    label: string;
    value: string;
    onChange: (v: string) => void;
    min: number;
    max?: number;
    /** Size of one step for a given value and direction. */
    step: (current: number, dir: 1 | -1) => number;
    inputStep: string;
    decimalLocale?: string;
    error?: string | null;
}> = ({ label, value, onChange, min, max = Infinity, step, inputStep, decimalLocale, error }) => {
    const id = React.useId();
    const errorId = React.useId();
    const n = decimalLocale ? recordDecimalValue(value, decimalLocale) : parseFloat(value);
    const hasNumber = Number.isFinite(n);
    const current = hasNumber ? n : min;
    const nudge = (dir: 1 | -1) => {
        const next = Math.min(max, Math.max(min, current + dir * step(current, dir)));
        const rounded = Math.round(next * 100) / 100;
        onChange(decimalLocale ? formatRecordDecimal(rounded, decimalLocale) : String(rounded));
    };
    const btn =
        'grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-35 disabled:hover:bg-transparent';
    return (
        <div className="space-y-1.5">
            <label htmlFor={id} className="field-label">
                {label}
            </label>
            <span className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={() => nudge(-1)}
                    disabled={current <= min}
                    aria-label={`${label} −`}
                    className={btn}
                >
                    <Minus size={16} />
                </button>
                <input
                    id={id}
                    type={decimalLocale ? 'text' : 'number'}
                    inputMode={decimalLocale && inputStep === '1' ? 'numeric' : 'decimal'}
                    min={decimalLocale ? undefined : min}
                    max={!decimalLocale && Number.isFinite(max) ? max : undefined}
                    step={decimalLocale ? undefined : inputStep}
                    role={decimalLocale ? 'spinbutton' : undefined}
                    aria-valuenow={decimalLocale && hasNumber ? n : undefined}
                    aria-valuetext={decimalLocale && !hasNumber && value ? value : undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    onKeyDown={
                        decimalLocale
                            ? e => {
                                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                                      e.preventDefault();
                                      nudge(e.key === 'ArrowUp' ? 1 : -1);
                                  }
                              }
                            : undefined
                    }
                    className="input-base min-w-0 flex-1 text-center text-sm font-medium tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                    type="button"
                    onClick={() => nudge(1)}
                    disabled={current >= max}
                    aria-label={`${label} +`}
                    className={btn}
                >
                    <Plus size={16} />
                </button>
            </span>
            {error && (
                <p id={errorId} className="field-hint is-error">
                    {error}
                </p>
            )}
        </div>
    );
};

export default Stepper;
