import {
    runSimulation,
    computeCalibration,
    geometricMeanRatio,
    interpolateConcentration_E2,
    interpolateConcentration_T,
    Route,
    Ester,
    ExtraKey,
} from '../../domain/engine';
import type { DoseEvent, LabResult, CalibrationPoint } from '../../domain/engine';
const X0 = 28,
    X1 = 306; // plot box, left and right
const Y0 = 20,
    Y1 = 118; // plot box, top and baseline
const DAYS = 56; // domain, 0 .. DAYS
const SAMPLES = 225; // points along the curve

/** 0.96 rather than 1 leaves the tallest peak a hair clear of the plot top. */
const HEAD_ROOM = 0.96;

const X = (day: number) => X0 + (day * (X1 - X0)) / DAYS;

// ── the demo regimen ─────────────────────────────────────────────────────
// Eight doses at one a week, and two labs placed in the second half where the
// curve has settled, so the gap between model and measurement reads as a
// standing offset rather than a bad guess about a single peak.
const DOSE_COUNT = 8;
const DOSE_INTERVAL_D = 7;
const WEIGHT_KG = 70;
const LAB_DAYS = [24.5, 45.5] as const;

/**
 * Two labs, not three. At three, `n` reaches MIN_LABS_FOR_CLEARANCE (logic.ts)
 * and MIPD starts fitting clearance as well as amplitude, which bends the
 * curve's *shape* at the very moment the reader is being asked to notice that
 * it came *down*. At two, kMul comes back exactly 1: the correction is pure
 * amplitude, so the only thing that changes is the one thing being claimed.
 */
const LAB_VALUES = {
    transfem: [192, 198],
    transmasc: [352, 364],
} as const;

export interface CurveData {
    unit: string;
    doseX: number[];
    modelD: string;
    calD: string;
    labs: { x: number; y: number }[];
}

const buildPath = (ys: number[], yMax: number): string => {
    const k = (Y1 - Y0) / yMax;
    return ys
        .map((v, i) => {
            const x = X0 + ((X1 - X0) * i) / (SAMPLES - 1);
            const y = Y1 - Math.max(0, v) * k;
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join('');
};

export const projectOnboarding = (isTransmasc: boolean): CurveData | null => {
    // Anchored so the last dose lands about now. `runSimulation` spreads its
    // grid from the first dose to max(lastDose + 14 d, now) under a step cap,
    // so events left near hour zero would get a grid stretched across every
    // hour since 1970 and the curve would come back faceted.
    const t0 = Date.now() / 3_600_000 - (DOSE_COUNT - 1) * DOSE_INTERVAL_D * 24;
    const at = (day: number) => t0 + day * 24;

    const events: DoseEvent[] = Array.from({ length: DOSE_COUNT }, (_, i) => ({
        id: `onboarding-dose-${i}`,
        route: Route.injection,
        ester: isTransmasc ? Ester.TC : Ester.EV,
        timeH: at(i * DOSE_INTERVAL_D),
        doseMG: isTransmasc ? 100 : 4,
        extras: { [ExtraKey.concentrationMGmL]: isTransmasc ? 200 : 20 },
    }));

    const sim = runSimulation(events, WEIGHT_KG);
    if (!sim) return null;

    const interpolate = isTransmasc ? interpolateConcentration_T : interpolateConcentration_E2;
    const values = Array.from({ length: SAMPLES }, (_, i) => interpolate(sim, at((i * DAYS) / (SAMPLES - 1))) ?? 0);

    const simMax = Math.max(...values);
    if (!(simMax > 0)) return null;
    const yMax = simMax / HEAD_ROOM;

    const labValues = LAB_VALUES[isTransmasc ? 'transmasc' : 'transfem'];
    const labs: LabResult[] = LAB_DAYS.map((day, i) => ({
        id: `onboarding-lab-${i}`,
        timeH: at(day),
        concValue: labValues[i],
        unit: isTransmasc ? 'ng/dl' : 'pg/ml',
    }));

    let scale: number;
    if (isTransmasc) {
        // `computeCalibrationPoints` drops every testosterone lab
        // (`.filter(r => !isT_LabUnit(r.unit))` in logic.ts), so `computeCalibration`
        // would hand back an identity fit and the beat would show nothing
        // happening. The points are therefore built here against the T series
        // and averaged with the engine's own `geometricMeanRatio`, which is the
        // arithmetic MIPD itself performs below the clearance threshold. No
        // second model enters the app; when the filter is fixed this branch goes.
        const points = labs
            .map((lab): CalibrationPoint | null => {
                const pred = interpolate(sim, lab.timeH);
                if (pred === null || !(pred > 0)) return null;
                return { id: lab.id, timeH: lab.timeH, obs: lab.concValue, pred, ratio: lab.concValue / pred };
            })
            .filter((p): p is CalibrationPoint => !!p);
        if (!points.length) return null;
        scale = geometricMeanRatio(points);
    } else {
        scale = computeCalibration(sim, events, WEIGHT_KG, labs, 'mipd', 'retrospective').scale;
    }

    const k = (Y1 - Y0) / yMax;
    return {
        unit: isTransmasc ? 'ng/dL' : 'pg/mL',
        doseX: Array.from({ length: DOSE_COUNT }, (_, i) => X(i * DOSE_INTERVAL_D)),
        modelD: buildPath(values, yMax),
        calD: buildPath(
            values.map(v => v * scale),
            yMax,
        ),
        labs: labs.map((lab, i) => ({
            x: X(LAB_DAYS[i]),
            y: Y1 - lab.concValue * k,
        })),
    };
};
