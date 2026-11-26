import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, isUnmodelledDrug } from '../../../logic';
import { refusedFieldProps, type DoseErrorField } from './refusedField';

interface OralFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    route: Route;
    errorField?: DoseErrorField;
    errorId?: string;
}

const OralFields: React.FC<OralFieldsProps> = ({
    ester,
    rawDose,
    e2Dose,
    onRawChange,
    onE2Change,
    route,
    errorField,
    errorId,
}) => {
    const { t } = useTranslation();
    // Cyproterone and the unmodelled drugs have no estradiol equivalent: their own dose is all there is.
    const rawOnly = ester === Ester.CPA || isUnmodelledDrug(ester);
    const rawId = React.useId();
    const e2Id = React.useId();

    return (
        <div className="grid grid-cols-2 gap-4">
            {ester !== Ester.E2 && (
                <div
                    className={`space-y-1.5 ${(ester === Ester.EV && route === Route.oral) || rawOnly ? 'col-span-2' : ''}`}
                >
                    <label htmlFor={rawId} className="field-label">
                        {t('field.dose_raw')}
                    </label>
                    <input
                        id={rawId}
                        {...refusedFieldProps(errorField === 'raw', errorId)}
                        type="text"
                        inputMode="decimal"
                        value={rawDose}
                        onChange={e => onRawChange(e.target.value)}
                        className="input-base w-full text-[var(--text)] font-medium"
                        placeholder="0.0"
                        style={{ fontSize: '16px' }}
                    />
                </div>
            )}

            {!(ester === Ester.EV && route === Route.oral) && !rawOnly && (
                <div className={`space-y-1.5 ${ester === Ester.E2 ? 'col-span-2' : ''}`}>
                    <label htmlFor={e2Id} className="field-label">
                        {t('field.dose_e2')}
                    </label>
                    <input
                        id={e2Id}
                        {...refusedFieldProps(errorField === 'equivalent', errorId)}
                        type="text"
                        inputMode="decimal"
                        value={e2Dose}
                        onChange={e => onE2Change(e.target.value)}
                        className="input-base w-full font-medium text-[var(--text)]"
                        placeholder="0.0"
                        style={{ fontSize: '16px' }}
                    />
                </div>
            )}

            {ester === Ester.EV && route === Route.oral && (
                <div className="col-span-2">
                    {/* No unit after the number: the label already ends in (mg). */}
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        {t('field.dose_e2')}: {e2Dose || '--'}
                    </p>
                </div>
            )}
        </div>
    );
};

export default OralFields;
