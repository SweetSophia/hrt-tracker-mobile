import React, { useMemo } from 'react';
import { useDemoProjection } from '../hooks/useDemoProjection';
import type { DemoCompute } from '../application/demoProtocol';
import type { CurveData } from '../application/demos/onboarding';
export type { CurveData } from '../application/demos/onboarding';

/**
 * The chart on the "how it works" step of the intro.
 *
 * It draws the same argument the product film makes, in one plane: eight doses
 * land on a timeline, a curve accumulates through them, then two lab results
 * arrive *below* that curve and the whole line comes down to meet them. The
 * third beat is the one worth the code — showing the model being wrong is the
 * only honest way to say what calibration is for, and it is the one thing the
 * step's prose can assert but not demonstrate.
 *
 * Every number plotted comes from `runSimulation` and `computeCalibration`,
 * the functions the Overview itself runs. Nothing here is a drawn squiggle
 * with plausible-looking bumps: if the engine's answer changes, this picture
 * changes with it, and a curve that could drift away from the product without
 * anyone noticing would be worse than no curve at all.
 */

// ── the plane ────────────────────────────────────────────────────────────
// Fixed for both modes and every phase, so nothing under the reader's eye
// rescales once it has been established.
const X0 = 28,
    X1 = 306; // plot box, left and right
const Y0 = 20,
    Y1 = 118; // plot box, top and baseline
const DAYS = 56; // domain, 0 .. DAYS

const X = (day: number) => X0 + (day * (X1 - X0)) / DAYS;

/** Prefetch while the language/mode steps remain interactive. */
export const useOnboardingCurve = (isTransmasc: boolean, runDemo?: DemoCompute) => {
    // eslint-disable-next-line react-hooks/purity -- Preserve the source clock for this memoized numerical input.
    const anchor = useMemo(() => ({ isTransmasc, nowMs: Date.now() }), [isTransmasc]);
    return useDemoProjection<'onboarding'>(
        { kind: 'onboarding', isTransmasc: anchor.isTransmasc, anchorMs: anchor.nowMs },
        runDemo,
    );
};

/** Matches the onboarding page's own background, so a marker reads as hollow. */
const HOLLOW = 'fill-[var(--bg)]';
const RULE = 'stroke-[var(--border)]';

const TICKS: { day: number; anchor: 'start' | 'middle' | 'end' }[] = [
    { day: 0, anchor: 'start' },
    { day: 14, anchor: 'middle' },
    { day: 28, anchor: 'middle' },
    { day: 42, anchor: 'middle' },
    { day: 56, anchor: 'end' },
];

/**
 * The sequence, as three beats the page can play one at a time: doses land on
 * the timeline, the curve draws through them, the labs arrive and the curve
 * comes down to meet them. Durations in ms; the page's own timer advances the
 * beat and the marks beside the chart play for the same span.
 */
export const BEATS = [1800, 3300, 2700] as const;
export type Beat = 0 | 1 | 2;

interface OnboardingCurveProps {
    data: CurveData | null;
    /** Which beat is playing. Everything from earlier beats stands still. */
    beat: Beat;
    /** Bump to replay the current beat from its start. */
    playKey: number;
    /** What the axes are, and that this is not the reader's own data. */
    caption: string;
    /** Both legend labels, already translated. */
    legend: { model: string; labs: string };
    /** Sits at the end of the legend row once there is one — the replay. */
    action?: React.ReactNode;
}

const OnboardingCurve: React.FC<OnboardingCurveProps> = ({ data, beat, playKey, caption, legend, action }) => (
    <>
        <svg
            viewBox="0 0 320 146"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            focusable="false"
            className="block h-auto w-full text-[var(--accent-ink)]"
        >
            {/* The spine of every beat, so it is there from the first paint
                with no animation of its own. */}
            <line x1={X0} y1={Y1} x2={X1} y2={Y1} strokeWidth={1} className={RULE} />

            {data && (
                /* Keyed so a replay remounts the beat and its animations start
                   over; React reuses nodes otherwise and a finished animation
                   stays finished. */
                <g key={playKey}>
                    {beat >= 1 && (
                        <g className={beat === 1 ? 'oc-frame-in' : undefined}>
                            <line x1={X0} y1={Y0} x2={X0} y2={Y1} strokeWidth={1} className={RULE} />
                            {[0.25, 0.5, 0.75].map(f => (
                                <line
                                    key={f}
                                    x1={X0}
                                    y1={Y1 - (Y1 - Y0) * f}
                                    x2={X1}
                                    y2={Y1 - (Y1 - Y0) * f}
                                    strokeWidth={1}
                                    opacity={0.55}
                                    className={RULE}
                                />
                            ))}
                            <g className="text-muted">
                                {/* The only numerals on screen are days. A level
                                    on the y axis would be a number to aim at, and
                                    this is somebody else's body. */}
                                {TICKS.map(({ day, anchor }) => (
                                    <text
                                        key={day}
                                        x={X(day)}
                                        y={131}
                                        fontSize={12}
                                        textAnchor={anchor}
                                        fill="currentColor"
                                    >
                                        {day}
                                    </text>
                                ))}
                                <text x={X0} y={12} fontSize={12} textAnchor="start" fill="currentColor">
                                    {data.unit}
                                </text>
                            </g>
                        </g>
                    )}

                    {/* Doses, on the zero rule rather than on the curve: this
                        beat is only about when they were taken. */}
                    {data.doseX.map((cx, i) => (
                        <circle
                            key={cx}
                            className={`${beat === 0 ? 'oc-pop' : ''} ${HOLLOW}`}
                            style={beat === 0 ? { animationDelay: `${i * 190}ms` } : undefined}
                            cx={cx}
                            cy={Y1}
                            r={3}
                            strokeWidth={1.5}
                            stroke="currentColor"
                        />
                    ))}

                    {/* pathLength normalises the line to 1 unit long, which is
                        what lets the CSS draw it on with a dasharray it can
                        write without knowing the geometry. In the last beat the
                        same line fades out as the ghost takes over. */}
                    {beat >= 1 && (
                        <path
                            className={beat === 1 ? 'oc-model-draw' : 'oc-model-out'}
                            d={data.modelD}
                            pathLength={1}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.75}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                    )}
                    {beat === 2 && (
                        <>
                            <path
                                className="oc-ghost-in"
                                d={data.modelD}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={1.75}
                                strokeDasharray="3 4"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                            <path
                                className="oc-cal-in"
                                d={data.calD}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={1.75}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                            {data.labs.map(({ x, y }, i) => (
                                <rect
                                    key={x}
                                    /* ResultChart's lab marker: an 8×8 square on
                                       its corner, in that chart's own lab colour.
                                       The first real result someone enters should
                                       look like the thing they were shown here. */
                                    className={`oc-pop ${HOLLOW} text-[#B5664C] dark:text-[#E0A38C]`}
                                    style={{ animationDelay: `${i * 180}ms` }}
                                    x={x - 4}
                                    y={y - 4}
                                    width={8}
                                    height={8}
                                    transform={`rotate(45 ${x} ${y})`}
                                    strokeWidth={1.75}
                                    stroke="currentColor"
                                />
                            ))}
                        </>
                    )}
                </g>
            )}
        </svg>

        {/* The caption comes before the legend: it says what the plane is, and
            the legend then names the two lines on it. It is also the sentence
            that has to be read whether or not the sequence ever plays, so it
            sits directly under the chart rather than below a legend that only
            arrives with the last beat. */}
        <p className="mt-2 text-xs leading-relaxed text-muted">{caption}</p>

        {/* Laid out from the first frame and only made visible in the last
            beat, so its arrival does not shove the rows below it down the
            page. */}
        {data && (
            <div
                key={playKey}
                className={`mt-1.5 flex items-center gap-4 text-xs text-muted ${beat === 2 ? 'oc-legend-in' : 'invisible'}`}
            >
                {/* One series in two states, so both swatches are the same
                    colour and only the dashes tell them apart. */}
                <span className="flex items-center gap-1.5">
                    <Swatch dashed />
                    {legend.model}
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch />
                    {legend.labs}
                </span>
                {action}
            </div>
        )}
    </>
);

const Swatch: React.FC<{ dashed?: boolean }> = ({ dashed }) => (
    <svg viewBox="0 0 14 4" width={14} height={4} aria-hidden="true" className="shrink-0 text-[var(--accent-ink)]">
        <line
            x1={0}
            y1={2}
            x2={14}
            y2={2}
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeDasharray={dashed ? '3 4' : undefined}
            opacity={dashed ? 0.28 : undefined}
        />
    </svg>
);

export default OnboardingCurve;
