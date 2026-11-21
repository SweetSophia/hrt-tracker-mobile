import {
    runSimulation,
    computeCalibration,
    interpolateConcentration_E2,
    Route,
    Ester,
    ExtraKey,
} from '../../domain/engine';
import type { DoseEvent, LabResult } from '../../domain/engine';
import type { CalibrationMethod } from '../../domain/engine';
import { clock, DemoProjectionCache } from './cache';
const D = 24;
const WEEK = 7 * D;
const DOSES = 12;
export const SPAN_H = DOSES * WEEK + 3 * D;
const SAMPLES = 280;
/** Labs in the second half of the picture: which dose they follow, and how many hours after it. */
export const LAB_SLOTS: [number, number][] = [
    [5, 100],
    [6, 160],
    [7, 40],
    [8, 150],
    [9, 70],
    [10, 165],
];
const Z90 = 1.6448536269514722;

export interface CalibrationGuideRequest {
    kind: 'calibration-guide';
    weight: number;
    baseNowMs: number;
    inputs: { method: CalibrationMethod; level: number; change: number; count: number; wrong: boolean };
}
interface ModelSeries {
    values: number[];
    ghost?: boolean;
    edge?: boolean;
    fillTo?: number;
}
export const projectCalibrationGuide = (
    request: CalibrationGuideRequest,
    cache: DemoProjectionCache,
    profileKey: string,
) => {
    const { weight, inputs } = request;
    const base = cache.read(['cal-base', profileKey, weight, request.baseNowMs], () =>
        clock(request.baseNowMs, () => {
            const t0 = Math.floor(Date.now() / 3_600_000) - SPAN_H;
            const events: DoseEvent[] = Array.from({ length: DOSES }, (_, i) => ({
                id: `cal-guide-${i}`,
                route: Route.injection,
                ester: Ester.EV,
                timeH: t0 + i * WEEK,
                doseMG: 5,
                extras: { [ExtraKey.concentrationMGmL]: 20 },
            }));
            const w = Math.min(120, Math.max(40, Math.round(weight || 60)));
            const sim = runSimulation(events, w);
            return { t0, events, sim, w };
        }),
    );
    return (() => {
        const { t0, events, sim, w } = base;
        if (!sim) return null;
        const at = (h: number) => interpolateConcentration_E2(sim, h) ?? 0;
        const n = inputs.count;
        const wrongAt = Math.min(n - 1, 2);
        const labs: LabResult[] = LAB_SLOTS.slice(0, n).map(([dose, after], i) => {
            const h = t0 + dose * WEEK + after;
            const ratio =
                (i >= 3 ? inputs.level * inputs.change : inputs.level) * (inputs.wrong && i === wrongAt ? 3 : 1);
            return { id: `cal-guide-lab-${i}`, timeH: h, concValue: Math.round(at(h) * ratio), unit: 'pg/ml' };
        });
        const cal = computeCalibration(sim, events, w, labs, inputs.method, 'retrospective');
        const hours = Array.from({ length: SAMPLES }, (_, i) => t0 + (i / (SAMPLES - 1)) * SPAN_H);
        const raw = hours.map(at);
        const fitted = hours.map((h, i) => raw[i] * cal.factorFn(h));
        const sd = cal.factorSdFn;
        const series: ModelSeries[] = [{ values: raw, ghost: true }];
        if (sd && inputs.method !== 'off') {
            const hi = hours.map((h, i) => fitted[i] * Math.exp(Z90 * sd(h)));
            const lo = hours.map((h, i) => fitted[i] * Math.exp(-Z90 * sd(h)));
            series.push({ values: hi, edge: true, fillTo: 2 }, { values: lo, edge: true });
        } else {
            // Keep the same number of lines, so switching method glides instead of snapping.
            series.push({ values: fitted, edge: true }, { values: fitted, edge: true });
        }
        series.push({ values: fitted });
        const lastLab = labs[labs.length - 1];
        return {
            series,
            labs: labs.map(l => ({ x: (l.timeH - t0) / D, y: l.concValue })),
            doses: events.map(e => (e.timeH - t0) / D),
            atLab: cal.factorFn(lastLab.timeH),
            halfLife: cal.halfLifeDeltaPct,
            fit: cal.fitErrPct,
        };
    })();
};
export type CalibrationGuideProjection = ReturnType<typeof projectCalibrationGuide>;
