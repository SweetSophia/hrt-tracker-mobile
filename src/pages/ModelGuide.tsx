import type { DemoCompute } from '../application/demoProtocol';
import { TRANSFEM, TRANSMASC, type RouteId } from '../application/demos/modelGuide';
import { useDemoProjection } from '../hooks/useDemoProjection';
import { ModelStatus } from '../components/ModelStatus';
import React, { useMemo, useState } from 'react';
import PageHeader, { PAGE_COLUMN } from '../components/PageHeader';
import Segmented from '../components/Segmented';
import AnimatedNumber from '../components/AnimatedNumber';
import ModelChart from '../components/ModelChart';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import { esterName, fill } from '../utils/regimenText';

/**
 * What the curve on the Overview is and where it comes from, as a page of
 * About. It used to send people to an article on another site; this says the
 * same few things in the app, beside pictures they can move.
 *
 * Every curve here is computed by runSimulation (and the calibrated one by
 * computeCalibration), the same functions the Overview runs, so the pictures
 * can never drift away from what the app actually does.
 */

const D = 24;

/** Two to four short facts in a row: the name small, the number at the size of a section title. */
const Readout: React.FC<{ items: { label: string; value: React.ReactNode }[] }> = ({ items }) => (
    <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
        {items.map(({ label, value }) => (
            <div key={label}>
                <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                <dd className="mt-0.5 text-xl font-light tabular-nums text-[var(--text)]">{value}</dd>
            </div>
        ))}
    </dl>
);

/** A labelled slider, its value at the end of the label line. */
const Slider: React.FC<{
    id: string;
    label: string;
    shown: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (v: number) => void;
}> = ({ id, label, shown, min, max, step, value, onChange }) => (
    <div className="mt-5">
        <label className="field-label flex justify-between" htmlFor={id}>
            <span>{label}</span>
            <span className="tabular-nums text-[var(--text)]">{shown}</span>
        </label>
        <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            className="mt-3 h-1 w-full accent-[var(--accent)]"
        />
    </div>
);

const Section: React.FC<{ title: string; text?: string; children?: React.ReactNode }> = ({ title, text, children }) => (
    <section className="mt-12 first:mt-0">
        <h2 className="text-xl font-normal text-[var(--text)]">{title}</h2>
        {text && <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">{text}</p>}
        {children}
    </section>
);

const round = (v: number) => (v >= 100 ? Math.round(v / 5) * 5 : Math.round(v));

const ModelGuide: React.FC<{ onBack: () => void; weight: number; runDemo?: DemoCompute }> = ({
    onBack,
    weight: savedWeight,
    runDemo,
}) => {
    const { t } = useTranslation();
    const { mode } = useHRTMode();
    const isT = mode === 'transmasc';
    const examples = isT ? TRANSMASC : TRANSFEM;
    const unit = isT ? 'ng/dL' : 'pg/mL';

    const [routeId, setRouteId] = useState<RouteId>('injection');
    const ex = examples.find(e => e.id === routeId) ?? examples[0];
    const [doses, setDoses] = useState<Partial<Record<RouteId, number>>>({});
    const [spacing, setSpacing] = useState<Partial<Record<RouteId, number>>>({});
    const [weight, setWeight] = useState(() => Math.min(120, Math.max(40, Math.round(savedWeight || 60))));
    const [labRatio, setLabRatio] = useState(0.7);

    const dose = doses[ex.id] ?? ex.dose.start;
    const everyH = spacing[ex.id] ?? ex.intervals[ex.intervals.length > 2 ? 1 : ex.intervals.length - 1];
    const xUnit = ex.days ? t('model_doc.axis.days') : t('model_doc.axis.hours');
    const toX = (h: number) => (ex.days ? h / D : h);
    const span = (h: number) =>
        ex.days
            ? fill(t('model_doc.n_days'), { n: +(h / D).toFixed(1) })
            : fill(t('model_doc.n_hours'), { n: Math.round(h) });

    // eslint-disable-next-line react-hooks/purity -- Preserve the source clock for this memoized numerical input.
    const singleAnchor = useMemo(() => ({ ex, dose, weight, isT, nowMs: Date.now() }), [ex, dose, weight, isT]);
    const repeatedAnchor = useMemo(
        // eslint-disable-next-line react-hooks/purity -- Spacing edits re-anchor only the repeated source curve.
        () => ({ ex, dose, everyH, weight, isT, nowMs: Date.now() }),
        [ex, dose, everyH, weight, isT],
    );
    const { value, status, retry } = useDemoProjection<'model-guide'>(
        {
            kind: 'model-guide',
            isTransmasc: isT,
            routeId: ex.id,
            dose,
            everyH,
            weight,
            labRatio,
            singleNowMs: singleAnchor.nowMs,
            repeatedNowMs: repeatedAnchor.nowMs,
        },
        runDemo,
    );
    const single = value?.single,
        repeated = value?.repeated,
        calibrated = value?.calibrated;

    const drug = esterName(ex.ester, t);
    const vd = isT ? 1 : 2;

    return (
        <div className="md:pb-32">
            <PageHeader title={t('drawer.model_title')} onBack={onBack} />
            <div className={`${PAGE_COLUMN} mt-3`}>
                <ModelStatus status={status} onRetry={retry} />
                <p className="text-sm leading-relaxed text-[var(--text)]">{t('model_doc.lead')}</p>

                <div className="mt-8">
                    <Segmented<RouteId>
                        options={examples.map(e => ({ id: e.id, label: t(`model_doc.route.${e.id}`) }))}
                        value={ex.id}
                        onChange={setRouteId}
                        aria-label={t('model_doc.route')}
                    />
                </div>

                <div className="mt-10">
                    <Section title={t('model_doc.single.title')} text={t('model_doc.single.text')}>
                        <Slider
                            id="model-doc-dose"
                            label={t('model_doc.dose')}
                            shown={`${dose} mg ${drug}`}
                            {...ex.dose}
                            value={dose}
                            onChange={v => setDoses(d => ({ ...d, [ex.id]: v }))}
                        />
                        <div className="mt-6">
                            {single && (
                                <ModelChart
                                    series={[{ values: single.values }]}
                                    xMax={toX(ex.singleH)}
                                    xUnit={xUnit}
                                    yUnit={unit}
                                    doses={[0]}
                                    // Fixed at the slider's top dose (the model is linear in dose), so a
                                    // bigger dose reads as a taller curve rather than relabelled axes.
                                    yMax={(single.peak * ex.dose.max) / dose}
                                    aria-label={t('model_doc.single.title')}
                                />
                            )}
                        </div>
                        {single && (
                            <Readout
                                items={[
                                    {
                                        label: t('model_doc.peak'),
                                        value: (
                                            <>
                                                <AnimatedNumber value={round(single.peak)} decimals={0} />
                                                <span className="ms-1 text-sm text-[var(--text-muted)]">{unit}</span>
                                            </>
                                        ),
                                    },
                                    { label: t('model_doc.peak_at'), value: span(single.peakH) },
                                ]}
                            />
                        )}
                    </Section>

                    <Section title={t('model_doc.repeat.title')} text={t('model_doc.repeat.text')}>
                        <div className="mt-5">
                            <p className="field-label mb-2">{t('model_doc.every')}</p>
                            <Segmented<string>
                                options={ex.intervals.map(h => ({ id: String(h), label: span(h) }))}
                                value={String(everyH)}
                                onChange={v => setSpacing(s => ({ ...s, [ex.id]: Number(v) }))}
                                aria-label={t('model_doc.every')}
                            />
                        </div>
                        <div className="mt-6">
                            {repeated && (
                                <ModelChart
                                    series={[{ values: repeated.values }]}
                                    xMax={toX(repeated.spanH)}
                                    xUnit={xUnit}
                                    yUnit={unit}
                                    doses={Array.from({ length: repeated.count }, (_, i) => toX(i * everyH))}
                                    aria-label={t('model_doc.repeat.title')}
                                />
                            )}
                        </div>
                        {repeated && (
                            <Readout
                                items={[
                                    {
                                        label: t('model_doc.range'),
                                        value: (
                                            <>
                                                {fill(t('model_doc.range_value'), {
                                                    lo: round(repeated.lo),
                                                    hi: round(repeated.hi),
                                                })}
                                                <span className="ms-1 text-sm text-[var(--text-muted)]">{unit}</span>
                                            </>
                                        ),
                                    },
                                ]}
                            />
                        )}
                    </Section>

                    <Section title={t('model_doc.weight.title')} text={fill(t('model_doc.weight.text'), { vd })}>
                        <Slider
                            id="model-doc-weight"
                            label={t('status.weight')}
                            shown={`${weight} kg`}
                            min={40}
                            max={120}
                            step={1}
                            value={weight}
                            onChange={setWeight}
                        />
                        {repeated && (
                            <Readout
                                items={[
                                    {
                                        label: t('model_doc.mean'),
                                        value: (
                                            <>
                                                <AnimatedNumber value={round(repeated.mean)} decimals={0} />
                                                <span className="ms-1 text-sm text-[var(--text-muted)]">{unit}</span>
                                            </>
                                        ),
                                    },
                                ]}
                            />
                        )}
                    </Section>

                    <Section title={t('model_doc.calibrate.title')} text={t('model_doc.calibrate.text')}>
                        <Slider
                            id="model-doc-lab"
                            label={t('model_doc.lab')}
                            shown={calibrated ? `${calibrated.obs} ${unit}` : '—'}
                            min={0.4}
                            max={1.8}
                            step={0.05}
                            value={labRatio}
                            onChange={setLabRatio}
                        />
                        {calibrated && repeated && (
                            <>
                                <div className="mt-6">
                                    {calibrated && (
                                        <ModelChart
                                            series={[
                                                { values: repeated.values, ghost: true },
                                                { values: calibrated.values },
                                            ]}
                                            xMax={toX(calibrated.spanH)}
                                            xUnit={xUnit}
                                            yUnit={unit}
                                            labs={[{ x: calibrated.labX, y: calibrated.obs }]}
                                            yMax={calibrated.yMax}
                                            aria-label={t('model_doc.calibrate.title')}
                                        />
                                    )}
                                </div>
                                <p className="mt-2 text-xs text-[var(--text-muted)]">
                                    {t('model_doc.calibrate.caption')}
                                </p>
                                <Readout
                                    items={[
                                        {
                                            label: t('model_doc.factor'),
                                            value: `× ${calibrated.scale.toFixed(2)}`,
                                        },
                                    ]}
                                />
                            </>
                        )}
                    </Section>

                    <Section title={t('model_doc.limits.title')}>
                        <ul className="mt-3 list-disc space-y-2 ps-5 text-sm leading-relaxed text-[var(--text-muted)] marker:text-[var(--border-strong)]">
                            <li>{t('model_doc.limits.1')}</li>
                            <li>{t('model_doc.limits.2')}</li>
                            <li>{t('model_doc.limits.3')}</li>
                        </ul>
                    </Section>
                </div>
            </div>
        </div>
    );
};

export default ModelGuide;
