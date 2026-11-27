import { Route, convertToNgDl, convertToPgMl, isEstradiolEster, isTestosteroneEster } from '../../logic';
import type { DoseEvent, LabResult } from '../../logic';
import { toDayKey } from '../utils/helpers';
import { labHormone } from './labels';
import type {
    PreparedReport,
    ReportChart,
    ReportEstimateSource,
    ReportHormone,
    ReportRecords,
    ReportSelection,
} from './types';

const HORMONE_ORDER: readonly ReportHormone[] = ['E2', 'T'];

const CHART_UNITS: Record<ReportHormone, ReportChart['unit']> = { E2: 'pg/mL', T: 'ng/dL' };

const RANGE_DATES: Record<'30' | '90', number> = { '30': 30, '90': 90 };

/** Only modeled curves are downsampled. Every measured lab point is retained. */
const MAX_CHART_POINTS = 400;

const HOUR_MS = 3600000;

const OPEN_BOUNDS = { startH: Number.NEGATIVE_INFINITY, endH: Number.POSITIVE_INFINITY };

/** Calendar-day arithmetic on the local date, so a shift in the clocks cannot move the day. */
function addLocalDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local midnight of a 'YYYY-MM-DD' date, or null when it is not one. */
function parseLocalDay(key: string): Date | null {
    const match = DATE_KEY.exec(key);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    // A date that does not exist (2026-02-30) rolls into the next month when
    // it is built, so it is checked against the day it was written with.
    return toDayKey(date) === key ? date : null;
}

interface ResolvedRange {
    /** Local calendar dates, or null for an open bound. */
    from: string | null;
    to: string | null;
    /** First instant of the first day, in hours since 1970. */
    startH: number;
    /** First instant of the day after the last day, in hours since 1970. */
    endH: number;
    invalid: boolean;
}

/** Use consecutive local midnights so 23- and 25-hour dates retain their calendar boundaries. */
function rangeBetween(fromDate: Date, toDate: Date): ResolvedRange {
    const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
    return {
        from: toDayKey(fromDate),
        to: toDayKey(toDate),
        startH: start.getTime() / HOUR_MS,
        endH: end.getTime() / HOUR_MS,
        invalid: false,
    };
}

function resolveRange(selection: ReportSelection, now: Date): ResolvedRange {
    if (selection.range === 'all') {
        return { from: null, to: null, ...OPEN_BOUNDS, invalid: false };
    }
    if (selection.range === 'custom') {
        const fromDate = parseLocalDay(selection.from);
        const toDate = parseLocalDay(selection.to);
        // A missing date, a date that does not exist, and a range that runs
        // backwards are all a range that cannot be shown.
        if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) {
            return {
                from: fromDate ? toDayKey(fromDate) : null,
                to: toDate ? toDayKey(toDate) : null,
                ...OPEN_BOUNDS,
                invalid: true,
            };
        }
        return rangeBetween(fromDate, toDate);
    }
    // The preset ranges cover the last N calendar dates, today included: the
    // window starts N - 1 days back, so it holds exactly N dates.
    return rangeBetween(addLocalDays(now, -(RANGE_DATES[selection.range] - 1)), now);
}

function withinRange(timeH: number, range: ResolvedRange): boolean {
    return timeH >= range.startH && timeH < range.endH;
}

/** Group by drug and route across dose strengths and pair patch removals with applications. */
export function reportMedicationKey(event: DoseEvent): string {
    const route = event.route === Route.patchRemove ? Route.patchApply : event.route;
    return `${route}:${event.ester}`;
}

function modeHormone(mode: ReportEstimateSource['mode']): ReportHormone {
    return mode === 'transmasc' ? 'T' : 'E2';
}

/** An antiandrogen-only history does not supply an estradiol dosing curve. */
function modelCovers(estimate: ReportEstimateSource, hormone: ReportHormone): boolean {
    return estimate.events.some(event => {
        if (event.route === Route.patchRemove) return false;
        return hormone === 'E2' ? isEstradiolEster(event.ester) : isTestosteroneEster(event.ester);
    });
}

/** The index of the first entry at or after a value, in an ascending list. */
function firstIndexAtOrAfter(sorted: readonly number[], value: number): number {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid] < value) low = mid + 1;
        else high = mid;
    }
    return low;
}

function interpolateSeries(times: readonly number[], values: readonly number[], at: number): number {
    const last = times.length - 1;
    if (at <= times[0]) return values[0];
    if (at >= times[last]) return values[last];
    const high = firstIndexAtOrAfter(times, at);
    if (times[high] === at) return values[high];
    const low = high - 1;
    const span = times[high] - times[low];
    if (span <= 0) return values[low];
    const ratio = (at - times[low]) / span;
    return values[low] + (values[high] - values[low]) * ratio;
}

/** The mobile worker supplies calibration factors at model samples. Interpolate between calibrated values for custom boundaries. */
function calibratedSeries(
    estimate: ReportEstimateSource,
    hormone: ReportHormone,
    first: number,
    last: number,
): { times: number[]; values: number[] } | null {
    const sim = estimate.simulation;
    const raw = hormone === 'E2' ? sim.concPGmL_E2 : sim.concNGdL_T;
    if (!raw || raw.length < sim.timeH.length) return null;
    const times: number[] = [];
    const values: number[] = [];
    for (let i = first; i <= last; i++) {
        const time = sim.timeH[i];
        let factor = 1;
        if (hormone === 'E2') {
            try {
                factor = estimate.calibrationFn(time);
            } catch {
                return null;
            }
        }
        const level = raw[i] * factor;
        if (!Number.isFinite(level)) return null;
        times.push(time);
        values.push(level);
    }
    return { times, values };
}

/** Preserve endpoints and each bucket’s extremes when reducing the number of plotted samples. */
function boundPoints(points: ReportChart['points'], max: number): ReportChart['points'] {
    if (points.length <= max) return points;
    const buckets = Math.max(1, Math.floor((max - 2) / 2));
    const kept: ReportChart['points'] = [];
    const size = points.length / buckets;
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor(bucket * size);
        const end = Math.min(points.length, Math.floor((bucket + 1) * size));
        if (end <= start) continue;
        let highest = start;
        let lowest = start;
        for (let i = start; i < end; i++) {
            if (points[i].value > points[highest].value) highest = i;
            if (points[i].value < points[lowest].value) lowest = i;
        }
        kept.push(points[highest]);
        if (lowest !== highest) kept.push(points[lowest]);
    }
    kept.push(points[0]);
    kept.push(points[points.length - 1]);
    kept.sort((a, b) => a.timeH - b.timeH);
    return kept.filter((point, i) => i === 0 || point.timeH !== kept[i - 1].timeH);
}

function measuredPoints(labs: readonly LabResult[], hormone: ReportHormone): ReportChart['points'] {
    const points: ReportChart['points'] = [];
    for (const lab of labs) {
        if (labHormone(lab) !== hormone) continue;
        const value = hormone === 'T' ? convertToNgDl(lab.concValue, lab.unit) : convertToPgMl(lab.concValue, lab.unit);
        if (!Number.isFinite(value)) continue;
        points.push({ timeH: lab.timeH, value });
    }
    points.sort((a, b) => a.timeH - b.timeH);
    return points;
}

/** Clip the active mode's calibrated, full-history curve to the selected dates and the present. */
function estimatedPoints(
    estimate: ReportEstimateSource,
    hormone: ReportHormone,
    range: ResolvedRange,
    nowH: number,
): ReportChart['points'] {
    if (!modelCovers(estimate, hormone)) return [];
    const times = estimate.simulation.timeH;
    if (!times.length) return [];
    // endH is the following midnight. A plotted endpoint belongs to the selected day.
    const lastIncludedH = (range.endH * HOUR_MS - 1) / HOUR_MS;
    const endH = Math.min(lastIncludedH, estimate.nowH, nowH);
    if (endH <= range.startH) return [];
    // The samples the curve needs: those inside the window, plus the ones on
    // either side of it, so a clipped edge can be interpolated.
    const first = Math.max(0, firstIndexAtOrAfter(times, range.startH) - 1);
    const last = Math.min(times.length - 1, firstIndexAtOrAfter(times, endH));
    const series = calibratedSeries(estimate, hormone, first, last);
    if (!series) return [];
    const points: ReportChart['points'] = [];
    const startH = range.startH;
    const seriesStart = series.times[0];
    const seriesEnd = series.times[series.times.length - 1];
    if (Number.isFinite(startH) && startH >= seriesStart && startH <= seriesEnd) {
        points.push({ timeH: startH, value: interpolateSeries(series.times, series.values, startH) });
    }
    for (let i = 0; i < series.times.length; i++) {
        const time = series.times[i];
        if (time > startH && time < endH) points.push({ timeH: time, value: series.values[i] });
    }
    if (endH >= seriesStart && endH <= seriesEnd) {
        points.push({ timeH: endH, value: interpolateSeries(series.times, series.values, endH) });
    }
    return boundPoints(points, MAX_CHART_POINTS);
}

/** Records are already scoped to the requested owner and modes. Preview and PDF consume the same filtered result. */
export function prepareReport(
    records: ReportRecords,
    selection: ReportSelection,
    now: Date,
    estimate?: ReportEstimateSource,
): PreparedReport {
    const range = resolveRange(selection, now);
    const selectedHormones = new Set(selection.hormones);
    const medications = selection.medications === null ? null : new Set(selection.medications);
    const keepEvent = (event: DoseEvent) =>
        withinRange(event.timeH, range) && (medications === null || medications.has(reportMedicationKey(event)));
    const keepLab = (lab: LabResult) => withinRange(lab.timeH, range) && selectedHormones.has(labHormone(lab));

    // The tables read newest first, as the dose PDF does. Rows that share a
    // moment keep the order they were logged in.
    const events = range.invalid ? [] : records.events.filter(keepEvent).sort((a, b) => b.timeH - a.timeH);
    const labResults = range.invalid ? [] : records.labResults.filter(keepLab).sort((a, b) => b.timeH - a.timeH);

    const charts: ReportChart[] = [];
    if (!range.invalid) {
        if (selection.measuredGraph) {
            for (const hormone of HORMONE_ORDER) {
                if (!selectedHormones.has(hormone)) continue;
                const points = measuredPoints(labResults, hormone);
                if (!points.length) continue;
                charts.push({ kind: 'measured', hormone, unit: CHART_UNITS[hormone], points });
            }
        }
        if (selection.estimatedGraph && estimate) {
            const hormone = modeHormone(estimate.mode);
            if (selectedHormones.has(hormone)) {
                const points = estimatedPoints(estimate, hormone, range, now.getTime() / HOUR_MS);
                if (points.length) charts.push({ kind: 'estimated', hormone, unit: CHART_UNITS[hormone], points });
            }
        }
    }

    return {
        events,
        labResults,
        selection: {
            ...selection,
            hormones: [...selection.hormones],
            medications: selection.medications === null ? null : [...selection.medications],
        },
        from: range.from,
        to: range.to,
        invalidRange: range.invalid,
        charts,
    };
}

export function defaultReportSelection(): ReportSelection {
    return {
        range: '90',
        from: '',
        to: '',
        hormones: ['E2', 'T'],
        medications: null,
        bothModes: false,
        measuredGraph: false,
        estimatedGraph: false,
    };
}
