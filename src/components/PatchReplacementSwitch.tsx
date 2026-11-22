import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import Switch from './Switch';

/**
 * The opt-in to retire the patch before this one when a patch dose is
 * logged. `context "manual"` follows the dose form's field styling, and
 * spacing to neighbours stays with the container around the row.
 */
const PatchReplacementSwitch: React.FC<{
    checked: boolean;
    onChange: (next: boolean) => void;
    context: 'plan' | 'manual';
}> = ({ checked, onChange, context }) => {
    const { t } = useTranslation();
    const id = React.useId();
    const descId = `${id}-desc`;
    const inForm = context === 'manual';
    return (
        <div className="flex items-start justify-between gap-4">
            <label htmlFor={id} className="cursor-pointer">
                <span className={inForm ? 'field-label' : 'block text-sm text-body'}>
                    {t('patch.replace_previous')}
                </span>
                <span id={descId} className={inForm ? 'field-hint' : 'mt-0.5 block text-xs leading-relaxed text-muted'}>
                    {t(inForm ? 'patch.replace_manual_hint' : 'patch.replace_plan_hint')}
                </span>
            </label>
            <Switch
                id={id}
                checked={checked}
                onChange={onChange}
                label={t('patch.replace_previous')}
                describedBy={descId}
            />
        </div>
    );
};

export default PatchReplacementSwitch;
