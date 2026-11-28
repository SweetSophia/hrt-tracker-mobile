import { Route, convertToNgDl, convertToPgMl, isEstradiolEster, isTestosteroneEster } from '../../logic';
import type { DoseEvent, LabResult } from '../../logic';
import { toDayKey } from '../utils/helpers';
import { scaleReportCharts } from './chartScale';
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

/** The worker supplies factors at model samples. Interpolate after calibration. */
function levelAtBoundary(
    times: readonly number[],
    level: (index: number) => number,
    hour: number,
    right: number,
): number {
    const rightLevel = level(right);
    if (hour === times[right]) return rightLevel;
    const left = right - 1;
    const leftLevel = level(left);
    const fraction = (hour - times[left]) / (times[right] - times[left]);
    return leftLevel + (rightLevel - leftLevel) * fraction;
}

/** Read calibrated values in order and retain only each bucket's extremes. */
function interiorPoints(
    times: readonly number[],
    level: (index: number) => number,
    from: number,
    to: number,
): ReportChart['points'] {
    const count = to - from;
    const capacity = MAX_CHART_POINTS - 2;
    const buckets = count <= capacity ? count : Math.floor(capacity / 2);
    const kept: ReportChart['points'] = [];
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = from + Math.floor((bucket * count) / buckets);
        const end = from + Math.floor(((bucket + 1) * count) / buckets);
        let lowIndex = start;
        let highIndex = start;
        let low = level(start);
        let high = low;
        for (let i = start + 1; i < end; i++) {
            const value = level(i);
            if (value < low) {
                low = value;
                lowIndex = i;
            }
            if (value > high) {
                high = value;
                highIndex = i;
            }
        }
        kept.push({ timeH: times[lowIndex], value: low });
        if (highIndex !== lowIndex) kept.push({ timeH: times[highIndex], value: high });
    }
    kept.sort((a, b) => a.timeH - b.timeH);
    return kept;
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
    const { simulation } = estimate;
    const times = simulation.timeH;
    const raw = hormone === 'E2' ? simulation.concPGmL_E2 : simulation.concNGdL_T;
    if (!times.length || !raw || raw.length < times.length) return [];
    // endH is the following midnight. A plotted endpoint belongs to the selected day.
    const lastIncludedH = (range.endH * HOUR_MS - 1) / HOUR_MS;
    const endH = Math.min(lastIncludedH, estimate.nowH, nowH);
    if (endH <= range.startH) return [];
    const start = Math.max(range.startH, times[0]);
    const end = Math.min(endH, times[times.length - 1]);
    if (end < start) return [];

    const first = firstIndexAtOrAfter(times, start);
    const last = firstIndexAtOrAfter(times, end);
    const level = (index: number) => {
        const value = raw[index] * (hormone === 'E2' ? estimate.calibrationFn(times[index]) : 1);
        if (!Number.isFinite(value)) throw new RangeError('Invalid report estimate.');
        return value;
    };
    try {
        const firstPoint = { timeH: start, value: levelAtBoundary(times, level, start, first) };
        if (start === end) return [firstPoint];
        const interiorStart = times[first] === start ? first + 1 : first;
        return [
            firstPoint,
            ...interiorPoints(times, level, interiorStart, last),
            { timeH: end, value: levelAtBoundary(times, level, end, last) },
        ];
    } catch {
        return [];
    }
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
        charts: scaleReportCharts(charts),
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
