import type { PreparedReport, ReportChart } from './types';

/** A round step for an axis, as used by the app's concentration chart. */
export function niceStep(raw: number): number {
    if (!(raw > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return nice * magnitude;
}

/** Leave room around the values for tick marks. Return null for unscalable values. */
export function buildDomain(min: number, max: number, steps = 4): [number, number] | null {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
    if (max === min) {
        // Give a single point room on the side away from zero.
        const grown = Math.abs(max) * 0.15;
        if (Number.isFinite(grown) && grown > 0) {
            if (max < 0) min = max - grown;
            else max = max + grown;
        } else {
            max = max * 2;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    }
    const pad = (max - min) * 0.12;
    const step = niceStep((max - min + 2 * pad) / steps);
    if (!Number.isFinite(step) || step <= 0) return null;
    const floorValue = Math.floor((min - pad) / step) * step;
    let high = Math.ceil((max + pad) / step) * step;
    if (!Number.isFinite(floorValue) || !Number.isFinite(high)) return null;
    // A negative measurement stays inside the axis. Nonnegative values start at zero or above.
    const low = min < 0 ? floorValue : Math.max(0, floorValue);
    if (high <= low) high = low + step;
    return Number.isFinite(high - low) && high > low ? [low, high] : null;
}

/** Use one axis per hormone and unit. Discard unscalable series before comparing ranges. */
export function scaleReportCharts(charts: readonly ReportChart[]): PreparedReport['charts'] {
    const ranges = new Map<string, { min: number; max: number }>();
    const candidates: { chart: ReportChart; group: string }[] = [];
    for (const chart of charts) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const point of chart.points) {
            if (!Number.isFinite(point.timeH) || !Number.isFinite(point.value)) continue;
            min = Math.min(min, point.value);
            max = Math.max(max, point.value);
        }
        if (!buildDomain(min, max)) continue;
        const group = chart.hormone + '|' + chart.unit;
        const range = ranges.get(group);
        ranges.set(group, { min: Math.min(min, range?.min ?? min), max: Math.max(max, range?.max ?? max) });
        candidates.push({ chart, group });
    }
    const domains = new Map([...ranges].map(([group, { min, max }]) => [group, buildDomain(min, max)]));
    return candidates.flatMap(({ chart, group }) => {
        const domain = domains.get(group);
        return domain ? [{ ...chart, domain }] : [];
    });
}
