import React from 'react';
import { ChevronDown } from '../icons';
import { useTranslation } from '../../contexts/LanguageContext';
import { NativeBackScope } from '../../hooks/useNativeBackOwner';
import { inertWhen } from '../../utils/inert';
import { GEL_PRESETS, convertGelAmount, formatGelMG, type GelPreset } from '../../utils/gelUnits';
import CustomSelect from '../CustomSelect';
import { LOCALE_MAP } from '../../utils/helpers';
import { formatRecordDecimal, parseRecordDecimal } from '../../utils/recordDecimal';

/** One counted unit, singular: the packs' own word for a ruler, pump or sachet. */
const unitLabel = (preset: GelPreset, t: (key: string) => string) => t(preset.unitKey).replace(/s$/, '');

/**
 * A calculator under the mg field: pick the box, say how many rulers, pumps or
 * sachets went on, and the mg field is filled with the estradiol that is in
 * them. The field stays the one source of truth, so nothing about a saved dose
 * changes; only the arithmetic that used to be done on paper moves in here.
 */
const GelDoseConverter: React.FC<{ onApply: (mg: string) => void }> = ({ onApply }) => {
    const { t, lang } = useTranslation();
    const locale = LOCALE_MAP[lang] ?? 'en-US';
    const [open, setOpen] = React.useState(false);
    const [presetId, setPresetId] = React.useState(GEL_PRESETS[0].id);
    const [amount, setAmount] = React.useState('');
    const [customMG, setCustomMG] = React.useState('');
    const [customUnit, setCustomUnit] = React.useState('');
    const bodyId = React.useId();
    const amountId = React.useId();
    const customMGId = React.useId();
    const customUnitId = React.useId();
    const formatErrorId = React.useId();

    const preset = GEL_PRESETS.find(p => p.id === presetId);
    const isCustom = presetId === 'custom';
    const enteredAmount = parseRecordDecimal(amount, locale);
    const enteredStrength = parseRecordDecimal(customMG, locale);
    const mgPerUnit = isCustom
        ? enteredStrength.kind === 'number'
            ? enteredStrength.value
            : undefined
        : preset?.mgPerUnit;
    const result =
        enteredAmount.kind === 'number' && mgPerUnit !== undefined
            ? convertGelAmount(enteredAmount.value, mgPerUnit)
            : null;
    const rounded = result === null ? null : Number(formatGelMG(result));
    const shownResult = rounded === null ? null : formatRecordDecimal(rounded, locale);
    const invalidAmount = enteredAmount.kind === 'invalid';
    const invalidStrength = isCustom && enteredStrength.kind === 'invalid';
    const unit = isCustom ? customUnit.trim() || t('gel.convert.unit_default') : preset ? unitLabel(preset, t) : '';

    const options = [
        ...GEL_PRESETS.map(p => {
            const grams = p.unitKey === 'gel.unit.gram' ? '' : ` (${p.gramsPerUnit} g)`;
            return {
                value: p.id,
                label: p.labelKey ? t(p.labelKey) : (p.label ?? p.id),
                description: `1 ${unitLabel(p, t)}${grams} = ${formatGelMG(p.mgPerUnit)} mg`,
            };
        }),
        { value: 'custom', label: t('gel.convert.custom') },
    ];

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                aria-controls={bodyId}
                className="flex w-full items-center gap-1.5 text-start text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            >
                {t('gel.convert.title')}
                <ChevronDown
                    size={14}
                    strokeWidth={1.75}
                    className={`chev shrink-0 opacity-70 ${open ? 'rotate-180' : ''}`}
                />
            </button>
            <div id={bodyId} className="disclosure" data-open={open} {...inertWhen(!open)}>
                <div className="disclosure-inner">
                    <NativeBackScope active={open}>
                        <div className="space-y-3 pt-3">
                            <CustomSelect
                                label={t('gel.convert.product')}
                                value={presetId}
                                onChange={setPresetId}
                                options={options}
                            />

                            {isCustom && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label htmlFor={customMGId} className="field-label">
                                            {t('gel.convert.custom_mg')}
                                        </label>
                                        <input
                                            id={customMGId}
                                            type="text"
                                            inputMode="decimal"
                                            value={customMG}
                                            aria-invalid={invalidStrength || undefined}
                                            aria-describedby={invalidStrength ? formatErrorId : undefined}
                                            onChange={e => setCustomMG(e.target.value)}
                                            className="input-base w-full text-[var(--text)]"
                                            placeholder="0.6"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label htmlFor={customUnitId} className="field-label">
                                            {t('gel.convert.custom_unit')}
                                        </label>
                                        <input
                                            id={customUnitId}
                                            type="text"
                                            value={customUnit}
                                            onChange={e => setCustomUnit(e.target.value)}
                                            className="input-base w-full text-[var(--text)]"
                                            placeholder={t('gel.convert.custom_unit_placeholder')}
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="space-y-1.5">
                                <label htmlFor={amountId} className="field-label">
                                    {t('gel.convert.amount')}
                                </label>
                                <div className="flex items-baseline gap-2">
                                    <input
                                        id={amountId}
                                        type="text"
                                        inputMode="decimal"
                                        value={amount}
                                        aria-invalid={invalidAmount || undefined}
                                        aria-describedby={invalidAmount ? formatErrorId : undefined}
                                        onChange={e => setAmount(e.target.value)}
                                        className="input-base min-w-0 flex-1 text-[var(--text)]"
                                        placeholder="1"
                                    />
                                    <span className="shrink-0 text-sm text-[var(--text-muted)]">{unit}</span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between gap-3">
                                <p aria-live="polite" className="field-hint">
                                    {t('gel.convert.result')}: {shownResult === null ? '—' : `${shownResult} mg`}
                                </p>
                                <button
                                    type="button"
                                    disabled={rounded === null || rounded <= 0}
                                    onClick={() => {
                                        if (shownResult === null) return;
                                        onApply(shownResult);
                                        setOpen(false);
                                    }}
                                    className="inline-flex shrink-0 items-center rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-body hover:bg-[var(--surface-hover)] disabled:opacity-40"
                                >
                                    {t('gel.convert.fill')}
                                </button>
                            </div>

                            {(invalidAmount || invalidStrength) && (
                                <p id={formatErrorId} className="field-hint is-error" role="alert">
                                    {t('error.decimalFormat').replace('{example}', formatRecordDecimal(1.5, locale))}
                                </p>
                            )}
                            <p className="field-hint">{t('gel.convert.note')}</p>
                        </div>
                    </NativeBackScope>
                </div>
            </div>
        </div>
    );
};

export default GelDoseConverter;
