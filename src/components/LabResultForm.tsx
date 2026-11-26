import { useNativeBackOwner } from '../hooks/useNativeBackOwner';
import React, { useState, useRef, useId } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { LabResult, LabAssay, LAB_ASSAYS, isT_LabUnit, convertToPgMl, convertToNgDl } from '../../logic';
import { Check, Trash } from './icons';
import { v4 as uuidv4 } from 'uuid';
import DateTimePicker from './DateTimePicker';
import CustomSelect, { SelectChevron } from './CustomSelect';
import Segmented from './Segmented';
import { LOCALE_MAP } from '../utils/helpers';
import { clinicalUnit } from '../utils/clinicalUnit';
import { formatRecordDecimal, parseRecordDecimal, type RecordDecimal } from '../utils/recordDecimal';

type LabUnit = LabResult['unit'];

interface LabResultFormProps {
    resultToEdit?: LabResult | null;
    onSave: (results: LabResult[]) => Promise<boolean>;
    onCancel: () => void;
    onDelete?: (id: string) => Promise<boolean>;
    /** Units a new entry starts in: the ones the person's last lab of each
     *  hormone used, so a clinic that reports pg/mL isn't met with pmol/L on
     *  every entry. Without a past lab, pmol/L and ng/dL. */
    defaultE2Unit?: LabUnit;
    defaultTUnit?: LabUnit;
    /** The test method a new entry starts with: the last lab's, since a
     *  clinic tends to use the same one every time. */
    defaultAssay?: LabAssay;
}

// "Not sure" is stored as no assay at all.
type AssayChoice = LabAssay | 'unknown';
const ASSAY_CHOICES: AssayChoice[] = ['unknown', ...LAB_ASSAYS];
const withAssay = (choice: AssayChoice) => (choice === 'unknown' ? {} : { assay: choice });

const divider = 'border-b-(length:--hairline) border-[var(--border)]';

const E2_UNITS: LabUnit[] = ['pmol/l', 'pg/ml'];
const T_UNITS: LabUnit[] = ['ng/dl', 'nmol/l'];

// A datetime-local input value in local time, which is what the picker edits.
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// A lab value worth saving: a real number above zero. Calibration drops a zero
// anyway, so Save stays disabled rather than accepting one and doing nothing.
const positiveLabValue = (parsed: RecordDecimal): number | null =>
    parsed.kind === 'number' && parsed.value > 0 ? parsed.value : null;

// The same value in the hormone's other unit, for display only. A number in
// the wrong unit is 3.67× (estradiol) or 29× (testosterone) off, and seeing
// "≈ 41 pg/mL" beside a 150 meant as pg/mL is what catches the slip.
const fmtApprox = (v: number) => (v >= 100 ? String(Math.round(v)) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
const otherUnitReading = (value: number, unit: LabUnit, units: LabUnit[], locale: string): string | null => {
    const other = units.find(u => u !== unit);
    if (!other) return null;
    const toBase = isT_LabUnit(unit) ? convertToNgDl : convertToPgMl;
    // Round with the shared thresholds, then reuse the cached record-decimal
    // formatting, so the mark follows the app locale ("40,9" in ru) without
    // building a NumberFormat per row.
    const approx = Number(fmtApprox(toBase(value, unit) / toBase(1, other)));
    return `≈ ${formatRecordDecimal(approx, locale)} ${clinicalUnit(other)}`;
};

// One hormone's value + unit toggle. Reused for the estradiol row, the
// testosterone row, and (in edit mode) the single row matching whichever
// hormone the record being edited already belongs to.
const HormoneValueField: React.FC<{
    label: string;
    units: LabUnit[];
    unit: LabUnit;
    onUnitChange: (u: LabUnit) => void;
    value: string;
    amount: number | null;
    error: string | null;
    /** Shown only after the field is left with an unfinished value. */
    blurHint: string | null;
    locale: string;
    onValueChange: (v: string) => void;
}> = ({ label, units, unit, onUnitChange, value, amount, error, blurHint, locale, onValueChange }) => {
    const id = useId();
    const errorId = useId();
    // An unfinished prefix is quiet while the person is typing; leaving the
    // field with one shows the hint, since Save is disabled without anything
    // else explaining why.
    const [isFocused, setIsFocused] = useState(false);
    const shownError = error ?? (!isFocused && blurHint ? blurHint : null);
    const reading = amount === null ? null : otherUnitReading(amount, unit, units, locale);
    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <label htmlFor={id} className="text-sm text-[var(--text)]">
                    {label}
                </label>
                <Segmented
                    options={units.map(u => ({ id: u, label: clinicalUnit(u) }))}
                    value={unit}
                    onChange={onUnitChange}
                    aria-label={label}
                />
            </div>
            {/* The other-unit reading sits inside the field, so it appears
                as you type without pushing the rows below it down. */}
            <div className="relative">
                <input
                    id={id}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={value}
                    onChange={e => onValueChange(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    aria-invalid={shownError ? true : undefined}
                    aria-describedby={shownError ? errorId : undefined}
                    className="input-base w-full text-[var(--text)] placeholder:text-[var(--text-muted)] tabular-nums"
                    style={{ fontSize: '16px', paddingInlineEnd: reading ? '7.5rem' : undefined }}
                />
                {reading && (
                    <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-[var(--text-muted)] tabular-nums">
                        {reading}
                    </span>
                )}
            </div>
            {shownError && (
                <p id={errorId} className="field-hint is-error">
                    {shownError}
                </p>
            )}
        </div>
    );
};

const LabResultForm: React.FC<LabResultFormProps> = ({
    resultToEdit,
    onSave,
    onCancel,
    onDelete,
    defaultE2Unit = 'pmol/l',
    defaultTUnit = 'ng/dl',
    defaultAssay,
}) => {
    const { t, lang } = useTranslation();
    const locale = LOCALE_MAP[lang] ?? 'en-US';
    const { showDialog } = useDialog();
    const [dateStr, setDateStr] = useState('');
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

    // Editing an existing record: single value tied to that record's hormone.
    const [editUnit, setEditUnit] = useState<LabUnit>('pmol/l');
    const [editValue, setEditValue] = useState('');

    // Adding new: estradiol and testosterone are independent fields, so one
    // blood draw covering both markers can be logged as a single entry at a
    // single timestamp instead of two separate saves. The add form is
    // remounted each time it opens, so the starting units are read once here.
    const [e2Unit, setE2Unit] = useState<LabUnit>(defaultE2Unit);
    const [e2Value, setE2Value] = useState('');
    const [tUnit, setTUnit] = useState<LabUnit>(defaultTUnit);
    const [tValue, setTValue] = useState('');
    const [assay, setAssay] = useState<AssayChoice>(defaultAssay ?? 'unknown');

    // Initialize from the record, by adjusting state during render (the React
    // pattern for reacting to prop changes; React 18 has no stable
    // useEffectEvent). The initializer runs whenever the record object is
    // replaced — reopening after a save or a remote same-id update picks up
    // the new result — but not on a language-only change, which preserves the
    // draft the person is typing; the parser accepts either decimal mark in
    // text that was already typed.
    // The prop is optional as well as nullable, so normalize before comparing:
    // an omitted prop must still run the add-date setup once.
    const record = resultToEdit ?? null;
    const [initializedFor, setInitializedFor] = useState<LabResult | null | undefined>(undefined);
    if (initializedFor !== record) {
        setInitializedFor(record);
        if (record) {
            setDateStr(toLocalInput(new Date(record.timeH * 3600000)));
            setEditValue(formatRecordDecimal(record.concValue, locale));
            setEditUnit(record.unit);
            setAssay(record.assay ?? 'unknown');
        } else {
            setDateStr(toLocalInput(new Date()));
            setE2Value('');
            setTValue('');
        }
    }

    const editInput = parseRecordDecimal(editValue, locale);
    const e2Input = parseRecordDecimal(e2Value, locale);
    const tInput = parseRecordDecimal(tValue, locale);
    const editNum = positiveLabValue(editInput);
    const e2Num = positiveLabValue(e2Input);
    const tNum = positiveLabValue(tInput);
    const formatError = t('error.decimalFormat').replace('{example}', formatRecordDecimal(1.5, locale));
    // Malformed text announces immediately. Unfinished prefixes like "0,"
    // (the parser's 'incomplete') are normal mid-typing states: quiet while
    // the field is focused, the same format hint once it is left blurred.
    const errorFor = (input: RecordDecimal): string | null => {
        if (input.kind === 'invalid') return formatError;
        return input.kind === 'number' && input.value <= 0 ? t('error.nonPositive') : null;
    };
    const blurHintFor = (input: RecordDecimal): string | null => (input.kind === 'incomplete' ? formatError : null);
    // A field left empty is fine, and so is a positive value. Anything else —
    // malformed text or an unfinished prefix like "0," — keeps Save disabled,
    // rather than saving the other field and silently dropping this one.
    const addFieldsOk = (e2Input.kind === 'empty' || e2Num !== null) && (tInput.kind === 'empty' || tNum !== null);

    const saving = useRef(false);
    useNativeBackOwner(() => {
        if (!saving.current) onCancel();
    });
    const handleSave = async () => {
        if (saving.current) return;
        saving.current = true;
        try {
            if (!dateStr) return;
            const timeH = new Date(dateStr).getTime() / 3600000;
            if (isNaN(timeH)) return;

            if (resultToEdit) {
                if (editNum === null) return;
                await onSave([{ id: resultToEdit.id, timeH, concValue: editNum, unit: editUnit, ...withAssay(assay) }]);
                return;
            }

            if (!addFieldsOk || (e2Num === null && tNum === null)) return;
            const results: LabResult[] = [];
            if (e2Num !== null)
                results.push({ id: uuidv4(), timeH, concValue: e2Num, unit: e2Unit, ...withAssay(assay) });
            if (tNum !== null) results.push({ id: uuidv4(), timeH, concValue: tNum, unit: tUnit, ...withAssay(assay) });
            await onSave(results);
        } finally {
            saving.current = false;
        }
    };

    const canSave = resultToEdit ? editNum !== null : addFieldsOk && (e2Num !== null || tNum !== null);
    const formatWhen = (d: Date) =>
        d.toLocaleString(locale, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    const editIsT = isT_LabUnit(editUnit);

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1">
                {/* Date row */}
                <button
                    type="button"
                    onClick={() => setIsDatePickerOpen(v => !v)}
                    className={`w-full flex items-center justify-between py-[18px] ${divider} text-start`}
                >
                    <span className="text-sm text-[var(--text)]">{t('lab.date')}</span>
                    <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                        <span className="text-sm tabular-nums">{dateStr ? formatWhen(new Date(dateStr)) : '—'}</span>
                        <SelectChevron open={isDatePickerOpen} />
                    </div>
                </button>
                <DateTimePicker
                    isOpen={isDatePickerOpen}
                    inline
                    onClose={() => setIsDatePickerOpen(false)}
                    onConfirm={date => {
                        setDateStr(toLocalInput(date));
                    }}
                    initialDate={dateStr ? new Date(dateStr) : new Date()}
                    mode="datetime"
                    title={t('lab.date')}
                />

                {resultToEdit ? (
                    <div className={`py-[18px] ${divider}`}>
                        <HormoneValueField
                            label={editIsT ? t('lab.value_t') : t('lab.value')}
                            units={editIsT ? T_UNITS : E2_UNITS}
                            unit={editUnit}
                            onUnitChange={setEditUnit}
                            value={editValue}
                            amount={editNum}
                            error={errorFor(editInput)}
                            blurHint={blurHintFor(editInput)}
                            locale={locale}
                            onValueChange={setEditValue}
                        />
                    </div>
                ) : (
                    <>
                        <div className={`py-[18px] ${divider}`}>
                            <HormoneValueField
                                label={t('lab.value')}
                                units={E2_UNITS}
                                unit={e2Unit}
                                onUnitChange={setE2Unit}
                                value={e2Value}
                                amount={e2Num}
                                error={errorFor(e2Input)}
                                blurHint={blurHintFor(e2Input)}
                                locale={locale}
                                onValueChange={setE2Value}
                            />
                        </div>
                        <div className={`py-[18px] ${divider}`}>
                            <HormoneValueField
                                label={t('lab.value_t')}
                                units={T_UNITS}
                                unit={tUnit}
                                onUnitChange={setTUnit}
                                value={tValue}
                                amount={tNum}
                                error={errorFor(tInput)}
                                blurHint={blurHintFor(tInput)}
                                locale={locale}
                                onValueChange={setTValue}
                            />
                        </div>
                    </>
                )}

                {/* How it was measured. Optional, and for both hormones of a
                    draw at once: one blood sample goes through one lab. */}
                <div className={`pt-1.5 pb-[18px] ${divider}`}>
                    <CustomSelect
                        inline
                        label={t('lab.assay')}
                        value={assay}
                        onChange={v => setAssay(v as AssayChoice)}
                        options={ASSAY_CHOICES.map(a => ({ value: a, label: t(`lab.assay.${a}`) }))}
                    />
                    {/* One line on the chosen method, so the choice can be made without looking it up. */}
                    <p className="text-xs text-[var(--text-muted)] pt-0.5">{t(`lab.assay_desc.${assay}`)}</p>
                </div>
                {!resultToEdit && <p className="text-xs text-[var(--text-muted)] pt-2">{t('lab.dual_hint')}</p>}
            </div>

            {/* Footer. Cancel and Save share the row at rest; at the largest
                text sizes they wrap onto full-width rows rather than clip. */}
            <div className="pt-4 flex flex-wrap items-center justify-between gap-2 shrink-0">
                {resultToEdit && onDelete && (
                    <button
                        type="button"
                        // The question is the heading; the body names the one
                        // result going, as saved, so the right row is deleted.
                        onClick={() =>
                            showDialog(
                                'confirm',
                                `${formatRecordDecimal(resultToEdit.concValue, lang === 'de' ? locale : 'en-US')} ${clinicalUnit(resultToEdit.unit)}\n${formatWhen(new Date(resultToEdit.timeH * 3600000))}`,
                                async () => {
                                    if (!(await onDelete(resultToEdit.id))) return;
                                    onCancel();
                                },
                                { danger: true, title: t('lab.delete_confirm'), confirmLabel: t('btn.delete') },
                            )
                        }
                        className="logging-touch-target flex items-center justify-center p-2 text-[var(--text-muted)] hover:text-[var(--danger)] rounded"
                        title={t('btn.delete')}
                        aria-label={t('btn.delete')}
                    >
                        <Trash size={16} />
                    </button>
                )}

                <div className="flex flex-wrap gap-x-2 gap-y-2 ml-auto grow justify-end sm:grow-0">
                    <button
                        onClick={onCancel}
                        className="logging-touch-target flex-1 sm:flex-none sm:min-w-[88px] px-4 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hover)] rounded-md flex items-center justify-center"
                    >
                        {t('btn.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave || !dateStr}
                        className="btn-primary logging-touch-target flex-1 sm:flex-none sm:min-w-[88px]"
                    >
                        <Check size={14} />
                        {t('btn.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LabResultForm;
