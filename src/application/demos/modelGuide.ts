import {
    runSimulation,
    computeCalibration,
    geometricMeanRatio,
    interpolateConcentration_E2,
    interpolateConcentration_T,
    Route,
    Ester,
    ExtraKey,
    sublingualThetaFromHold,
} from '../../domain/engine';
import type { DoseEvent, LabResult, SimulationResult } from '../../domain/engine';
import { clock, DemoProjectionCache } from './cache';
export type RouteId = 'injection' | 'oral' | 'sublingual' | 'gel';

interface Example {
    id: RouteId;
    route: Route;
    ester: Ester;
    extras?: Partial<Record<ExtraKey, number>>;
    dose: { min: number; max: number; step: number; start: number };
    /** Spacing choices for the repeated-dose picture, in hours. */
    intervals: number[];
    /** How long one dose is followed for, in hours. */
    singleH: number;
    /** Long-acting routes read in days, the rest in hours. */
    days: boolean;
}

const D = 24;

export const TRANSFEM: Example[] = [
    {
        id: 'injection',
        route: Route.injection,
        ester: Ester.EV,
        extras: { [ExtraKey.concentrationMGmL]: 20 },
        dose: { min: 1, max: 10, step: 0.5, start: 5 },
        intervals: [5 * D, 7 * D, 10 * D],
        singleH: 14 * D,
        days: true,
    },
    {
        id: 'oral',
        route: Route.oral,
        ester: Ester.E2,
        dose: { min: 0.5, max: 8, step: 0.5, start: 2 },
        intervals: [12, 24],
        singleH: 72,
        days: false,
    },
    {
        id: 'sublingual',
        route: Route.sublingual,
        ester: Ester.E2,
        extras: { [ExtraKey.sublingualTheta]: sublingualThetaFromHold(10) },
        dose: { min: 0.5, max: 4, step: 0.5, start: 1 },
        intervals: [8, 12, 24],
        singleH: 36,
        days: false,
    },
    {
        id: 'gel',
        route: Route.gel,
        ester: Ester.E2,
        extras: { [ExtraKey.gelSite]: 0 },
        dose: { min: 0.5, max: 4, step: 0.25, start: 1.5 },
        intervals: [12, 24],
        singleH: 96,
        days: false,
    },
];

export const TRANSMASC: Example[] = [
    {
        id: 'injection',
        route: Route.injection,
        ester: Ester.TC,
        extras: { [ExtraKey.concentrationMGmL]: 200 },
        dose: { min: 25, max: 200, step: 25, start: 100 },
        intervals: [7 * D, 10 * D, 14 * D],
        singleH: 21 * D,
        days: true,
    },
    {
        id: 'oral',
        route: Route.oral,
        ester: Ester.TU,
        dose: { min: 40, max: 240, step: 40, start: 80 },
        intervals: [12, 24],
        singleH: 36,
        days: false,
    },
    {
        id: 'gel',
        route: Route.gel,
        ester: Ester.T,
        extras: { [ExtraKey.gelSite]: 0 },
        dose: { min: 25, max: 100, step: 12.5, start: 50 },
        intervals: [12, 24],
        singleH: 96,
        days: false,
    },
];

const SAMPLES = 240;

interface Run {
    sim: SimulationResult;
    events: DoseEvent[];
    /** Hour zero of the picture, on the engine's clock. */
    t0: number;
    spanH: number;
}

/**
 * Doses land so the last one is a little before now: runSimulation lays its
 * grid from the first dose to whichever is later, now or two weeks past the
 * last dose, so a regimen parked near hour zero would be sampled across every
 * hour since 1970.
 */
const simulate = (ex: Example, dose: number, count: number, everyH: number, spanH: number, weight: number) => {
    const t0 = Math.floor(Date.now() / 3_600_000) - spanH;
    const events: DoseEvent[] = Array.from({ length: count }, (_, i) => ({
        id: `model-guide-${i}`,
        route: ex.route,
        ester: ex.ester,
        timeH: t0 + i * everyH,
        doseMG: dose,
        extras: ex.extras ?? {},
    }));
    const sim = runSimulation(events, weight);
    return sim ? ({ sim, events, t0, spanH } as Run) : null;
};

const sample = (run: Run | null, isT: boolean): number[] => {
    if (!run) return [];
    const at = isT ? interpolateConcentration_T : interpolateConcentration_E2;
    return Array.from({ length: SAMPLES }, (_, i) => at(run.sim, run.t0 + (i / (SAMPLES - 1)) * run.spanH) ?? 0);
};

const round = (v: number) => (v >= 100 ? Math.round(v / 5) * 5 : Math.round(v));
export interface ModelGuideRequest {
    kind: 'model-guide';
    isTransmasc: boolean;
    routeId: RouteId;
    dose: number;
    everyH: number;
    weight: number;
    labRatio: number;
    singleNowMs: number;
    repeatedNowMs: number;
}

export const projectModelGuide = (request: ModelGuideRequest, cache: DemoProjectionCache, profileKey: string) => {
    const isT = request.isTransmasc,
        ex = (isT ? TRANSMASC : TRANSFEM).find(e => e.id === request.routeId)!;
    const { dose, everyH, weight, labRatio } = request;
    const toX = (h: number) => (ex.days ? h / D : h);
    const single = cache.read(['single', profileKey, ex, dose, weight, isT, request.singleNowMs], () =>
        clock(request.singleNowMs, () => {
            const run = simulate(ex, dose, 1, 0, ex.singleH, weight);
            const values = sample(run, isT);
            let peakI = 0;
            values.forEach((v, i) => {
                if (v > values[peakI]) peakI = i;
            });
            return { values, peak: values[peakI] ?? 0, peakH: (peakI / (SAMPLES - 1)) * ex.singleH };
        }),
    );
    const repeated = cache.read(['repeated', profileKey, ex, dose, everyH, weight, isT, request.repeatedNowMs], () =>
        clock(request.repeatedNowMs, () => {
            const count = Math.max(4, Math.ceil((ex.days ? 56 * D : 7 * D) / everyH));
            const spanH = count * everyH;
            const run = simulate(ex, dose, count, everyH, spanH, weight);
            const values = sample(run, isT);
            // The last interval is the settled one.
            const tail = values.slice(Math.floor(((count - 1) / count) * (SAMPLES - 1)));
            const lo = Math.min(...tail),
                hi = Math.max(...tail);
            const mean = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
            return { run, values, spanH, count, lo, hi, mean };
        }),
    );
    const calibrated = (() => {
        const { run, count, spanH, values } = repeated;
        if (!run) return null;
        const labH = run.t0 + (count - 1) * everyH - 0.5;
        const at = isT ? interpolateConcentration_T : interpolateConcentration_E2;
        const pred = at(run.sim, labH) ?? 0;
        if (!(pred > 0)) return null;
        const obs = round(pred * labRatio);
        let scale: number;
        if (isT) {
            // computeCalibration skips testosterone labs, so the one-lab
            // arithmetic it would do is done with its own helper.
            scale = geometricMeanRatio([{ id: 'lab', timeH: labH, obs, pred, ratio: obs / pred }]);
        } else {
            const labs: LabResult[] = [{ id: 'model-guide-lab', timeH: labH, concValue: obs, unit: 'pg/ml' }];
            scale = computeCalibration(run.sim, run.events, weight, labs, 'mipd', 'retrospective').scale;
        }
        return {
            obs,
            scale,
            labX: toX(labH - run.t0),
            values: values.map(v => v * scale),
            // Fixed at the slider's top, so dragging moves the line and not the axis.
            yMax: Math.max(...values) * 1.85,
            spanH,
        };
    })();
    const { run: _run, ...visibleRepeated } = repeated;
    return { single, repeated: visibleRepeated, calibrated };
};
export type ModelGuideProjection = ReturnType<typeof projectModelGuide>;
