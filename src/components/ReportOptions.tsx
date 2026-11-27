import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hormoneLabel, labHormone, medicationLabel } from '../reports/labels';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useApplicationRuntime } from '../contexts/RecordsContext';
import { useLauncherShortcutBlocker } from '../hooks/useLauncherShortcut';
import { defaultReportSelection, prepareReport, reportMedicationKey } from '../reports/prepareReport';
import type { ReportEstimateSource, ReportHormone, ReportRecords, ReportSelection } from '../reports/types';
import { createDayLabelFormatter, LOCALE_MAP } from '../utils/helpers';
import { fill } from '../utils/regimenText';
import CustomSelect from './CustomSelect';

export interface ReportOptionsProps extends ReportRecords {
    readOtherMode: () => ReportRecords;
    reportNow: Date;
    estimate?: ReportEstimateSource;
}

const hormones: readonly ReportHormone[] = ['E2', 'T'];
const rangeKeys = { '30': 'report.last30', '90': 'report.last90', all: 'report.all_time', custom: 'report.custom' };

function Choice({
    label,
    checked,
    onChange,
    mixed,
    describedBy,
}: {
    label: string;
    checked: boolean;
    onChange: () => void;
    mixed?: boolean;
    describedBy?: string;
}) {
    return (
        <label className="flex min-h-12 items-center gap-3 text-sm text-[var(--text)]">
            <input
                type="checkbox"
                checked={checked}
                onChange={onChange}
                aria-describedby={describedBy}
                ref={node => {
                    if (node) node.indeterminate = !!mixed;
                }}
                className="size-5 shrink-0 accent-[var(--accent-ink)]"
            />
            {label}
        </label>
    );
}

export default function ReportOptions({
    events,
    labResults,
    readOtherMode,
    reportNow,
    estimate,
    saving,
    onSavingChange,
}: ReportOptionsProps & { saving: boolean; onSavingChange: (value: boolean) => void }) {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const { files } = useApplicationRuntime();
    const [selection, setSelection] = useState(defaultReportSelection);
    const [saveNotice, setSaveNotice] = useState('');
    const savingRef = useRef(false);
    const mounted = useRef(false);
    const hintId = useId();
    const customSelection =
        selection.range !== '90' ||
        selection.bothModes ||
        selection.medications !== null ||
        selection.hormones.length !== 2 ||
        selection.measuredGraph ||
        selection.estimatedGraph;
    useLauncherShortcutBlocker(saving || (customSelection && !saveNotice));
    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const records = useMemo((): ReportRecords | null => {
        if (!selection.bothModes) return { events, labResults };
        try {
            const other = readOtherMode();
            return { events: [...events, ...other.events], labResults: [...labResults, ...other.labResults] };
        } catch {
            return null;
        }
    }, [events, labResults, selection.bothModes, readOtherMode]);

    const medications = useMemo(() => {
        const items = new Map<string, string>();
        for (const event of records?.events ?? []) {
            const key = reportMedicationKey(event);
            if (!items.has(key)) items.set(key, medicationLabel(event, t));
        }
        return [...items].sort((a, b) => a[1].localeCompare(b[1], LOCALE_MAP[lang]));
    }, [records, lang, t]);
    const report = useMemo(
        () => records && prepareReport(records, selection, reportNow, estimate),
        [records, selection, reportNow, estimate],
    );
    const included = selection.medications;
    const checkedMeds = medications.filter(([key]) => included === null || included.includes(key));
    const allMeds = included === null || (medications.length > 0 && checkedMeds.length === medications.length);
    const missingMeasured = selection.measuredGraph && !report?.charts.some(chart => chart.kind === 'measured');
    const missingEstimate = selection.estimatedGraph && !report?.charts.some(chart => chart.kind === 'estimated');
    const hasContent = !!report && !!(report.events.length || report.labResults.length || report.charts.length);
    const canSave = hasContent && !report?.invalidRange && !missingMeasured && !missingEstimate;

    function change(fields: Partial<ReportSelection>) {
        setSelection(previous => ({ ...previous, ...fields }));
        setSaveNotice('');
    }
    function toggleMedication(key: string) {
        const selected = new Set(checkedMeds.map(([id]) => id));
        if (!selected.delete(key)) selected.add(key);
        change({ medications: selected.size === medications.length ? null : [...selected] });
    }
    async function save() {
        if (!report || !canSave || savingRef.current) return;
        savingRef.current = true;
        onSavingChange(true);
        setSaveNotice('');
        try {
            const { saveReport } = await import('../reports/pdf');
            if (!mounted.current) return;
            const result = await saveReport(report, lang, t, {
                save: request => (mounted.current ? files.save(request) : Promise.resolve('cancelled')),
            });
            if (mounted.current && result !== 'cancelled') {
                setSaveNotice(result === 'saved' ? 'report.saved' : 'report.downloaded');
            }
        } catch {
            if (mounted.current) showDialog('alert', t('export.file_failed'));
        } finally {
            savingRef.current = false;
            if (mounted.current) onSavingChange(false);
        }
    }

    const dateLabel = createDayLabelFormatter(lang);
    const rangeLabel =
        report?.from && report.to && !report.invalidRange
            ? [report.from, report.to].map(d => dateLabel(new Date(d + 'T12:00:00'))).join(' – ')
            : t(rangeKeys[selection.range]);
    const list = new Intl.ListFormat(LOCALE_MAP[lang]);
    const shownMeds = new Set(report?.events.map(reportMedicationKey));
    const shownHormones = new Set(report?.labResults.map(labHormone));
    const graphNames =
        report?.charts.map(
            chart =>
                `${t(chart.kind === 'measured' ? 'report.measured' : 'report.estimated')} (${hormoneLabel(chart.hormone, t)})`,
        ) ?? [];

    return (
        <fieldset disabled={saving} className="min-w-0 space-y-5 py-4">
            <CustomSelect
                label={t('report.range')}
                value={selection.range}
                options={Object.entries(rangeKeys).map(([value, key]) => ({ value, label: t(key) }))}
                onChange={value => change({ range: value as ReportSelection['range'] })}
            />
            {selection.range === 'custom' && (
                <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
                    {(['from', 'to'] as const).map(bound => (
                        <label key={bound} className="min-w-0">
                            <span className="field-label">{t(`report.${bound}`)}</span>
                            <input
                                className="input-base w-full min-w-0 min-h-12"
                                type="date"
                                value={selection[bound]}
                                onChange={e => change({ [bound]: e.target.value })}
                            />
                        </label>
                    ))}
                </div>
            )}
            <Choice
                label={t('report.both_modes')}
                checked={selection.bothModes}
                onChange={() => change({ bothModes: !selection.bothModes })}
            />
            <fieldset>
                <legend className="field-label">{t('report.hormones')}</legend>
                {hormones.map(hormone => (
                    <Choice
                        key={hormone}
                        label={hormoneLabel(hormone, t)}
                        checked={selection.hormones.includes(hormone)}
                        onChange={() =>
                            change({
                                hormones: selection.hormones.includes(hormone)
                                    ? selection.hormones.filter(value => value !== hormone)
                                    : [...selection.hormones, hormone],
                            })
                        }
                    />
                ))}
            </fieldset>
            {medications.length > 0 && (
                <fieldset>
                    <legend className="field-label">{t('report.medications')}</legend>
                    <Choice
                        label={t('report.all_medications')}
                        checked={allMeds}
                        mixed={!allMeds && checkedMeds.length > 0}
                        onChange={() => change({ medications: allMeds ? [] : null })}
                    />
                    {medications.map(([key, label]) => (
                        <Choice
                            key={key}
                            label={label}
                            checked={included === null || included.includes(key)}
                            onChange={() => toggleMedication(key)}
                        />
                    ))}
                </fieldset>
            )}
            <fieldset>
                <legend className="field-label">{t('report.graphs')}</legend>
                <Choice
                    label={t('report.measured')}
                    checked={selection.measuredGraph}
                    onChange={() => change({ measuredGraph: !selection.measuredGraph })}
                />
                <Choice
                    label={t('report.estimated')}
                    checked={selection.estimatedGraph}
                    describedBy={hintId}
                    onChange={() => change({ estimatedGraph: !selection.estimatedGraph })}
                />
                <p id={hintId} className="field-hint">
                    {t('report.estimate_hint')}
                </p>
            </fieldset>
            <section className="space-y-2 border-t border-[var(--border)] pt-4" aria-live="polite">
                <h2 className="font-medium">{t('report.preview')}</h2>
                {report && !report.invalidRange && (
                    <>
                        <p className="text-sm">{rangeLabel}</p>
                        <p className="text-sm">
                            {t('report.medications')} ·{' '}
                            {list.format(medications.filter(([key]) => shownMeds.has(key)).map(([, name]) => name)) ||
                                t('report.none')}
                        </p>
                        <p className="text-sm">
                            {t('report.hormones')} ·{' '}
                            {list.format([...shownHormones].map(hormone => hormoneLabel(hormone, t))) ||
                                t('report.none')}
                        </p>
                        {graphNames.length > 0 && (
                            <p className="text-sm">
                                {t('report.graphs')} · {list.format(graphNames)}
                            </p>
                        )}
                        <p className="text-sm">
                            {fill(t('report.counts'), { doses: report.events.length, labs: report.labResults.length })}
                        </p>
                    </>
                )}
                {!report ? (
                    <p>{t('storage.open_failed')}</p>
                ) : report.invalidRange ? (
                    <p>{t('report.invalid_range')}</p>
                ) : (
                    <>
                        {missingMeasured && <p className="field-hint">{t('report.measured_unavailable')}</p>}
                        {missingEstimate && <p className="field-hint">{t('report.estimate_unavailable')}</p>}
                        {!hasContent && <p className="field-hint">{t('report.empty')}</p>}
                    </>
                )}
            </section>
            <button
                type="button"
                disabled={!canSave || saving}
                onClick={() => void save()}
                className="btn-primary min-h-12"
            >
                {t(saving ? 'report.saving' : 'report.save')}
            </button>
            <p role="status" className="text-sm text-[var(--text-muted)]">
                {saveNotice && t(saveNotice)}
            </p>
        </fieldset>
    );
}
