import { afterEach, describe, expect, it } from 'vitest';
import { Ester, ExtraKey, Route, type DoseEvent, type LabResult, type SimulationResult } from '../logic';
import { defaultReportSelection, prepareReport, reportMedicationKey } from '../src/reports/prepareReport';
import type { ReportEstimateSource, ReportRecords, ReportSelection } from '../src/reports/types';

const HOUR = 3600000;

/** An instant, in hours since 1970, from its UTC parts. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number =>
    Date.UTC(year, month - 1, day, hour, minute, second, ms) / HOUR;

/** The clock the report is prepared for: 27 November 2026, midday. */
const NOW = new Date(Date.UTC(2026, 10, 27, 12));

function dose(
    id: string,
    route: Route,
    ester: Ester,
    doseMG: number,
    timeH: number,
    extras: Partial<Record<ExtraKey, number>> = {},
): DoseEvent {
    return { id, route, ester, doseMG, timeH, extras };
}

function lab(id: string, timeH: number, concValue: number, unit: LabResult['unit'] = 'pg/ml'): LabResult {
    return { id, timeH, concValue, unit };
}

function selection(overrides: Partial<ReportSelection> = {}): ReportSelection {
    return { ...defaultReportSelection(), ...overrides };
}

/** The model's sample times, and the calibration factor known at each of them. */
const SAMPLE_TIMES = [100, 110, 120, 190, 210, 300];
const FACTORS = new Map<number, number>([
    [100, 1],
    [110, 2],
    [120, 3],
    [190, 4],
    [210, 5],
]);

/**
 * An Overview model that only answers at its own sample times, the way the
 * model worker hands one over: any other time throws.
 */
function estimateSource(overrides: Partial<ReportEstimateSource> = {}): {
    estimate: ReportEstimateSource;
    calls: number[];
} {
    const calls: number[] = [];
    const simulation: SimulationResult = {
        timeH: [...SAMPLE_TIMES],
        concPGmL: SAMPLE_TIMES.map(() => 0),
        concPGmL_E2: [1, 2, 3, 4, 5, 6],
        concPGmL_CPA: SAMPLE_TIMES.map(() => 0),
        concPGmL_BICA: SAMPLE_TIMES.map(() => 0),
        concNGdL_T: [10, 20, 30, 40, 50, 60],
        auc: 0,
    };
    const estimate: ReportEstimateSource = {
        mode: 'transfem',
        events: [dose('e2-dose', Route.oral, Ester.E2, 2, 100)],
        simulation,
        calibrationFn: (timeH: number) => {
            calls.push(timeH);
            const factor = FACTORS.get(timeH);
            if (factor === undefined) throw new Error('Model sample unavailable.');
            return factor;
        },
        nowH: 200,
        ...overrides,
    };
    return { estimate, calls };
}

describe('the report opens on the last 90 days, everything, no graphs', () => {
    it('starts from the last 90 days up to today', () => {
        expect(defaultReportSelection().range).toBe('90');
        const report = prepareReport({ events: [], labResults: [] }, defaultReportSelection(), NOW);
        expect(report.from).toBe('2026-08-30');
        expect(report.to).toBe('2026-11-27');
    });

    it('takes every medication, both hormones and the current mode only', () => {
        const chosen = defaultReportSelection();
        expect(chosen.medications).toBeNull();
        expect(chosen.hormones).toEqual(['E2', 'T']);
        expect(chosen.bothModes).toBe(false);
        expect(chosen.measuredGraph).toBe(false);
        expect(chosen.estimatedGraph).toBe(false);
    });

    it('reads the 30 day range as the last 30 days', () => {
        const report = prepareReport({ events: [], labResults: [] }, selection({ range: '30' }), NOW);
        expect(report.from).toBe('2026-10-29');
        expect(report.to).toBe('2026-11-27');
    });
});

describe('the preset ranges hold exactly their own number of dates', () => {
    it('takes 90 dates: today and the 89 days before it', () => {
        const events = [
            dose('earliest', Route.oral, Ester.E2, 2, at(2026, 8, 30, 0, 0, 0, 0)),
            dose('the-day-before', Route.oral, Ester.E2, 2, at(2026, 8, 29, 23, 59, 59, 999)),
            dose('today', Route.oral, Ester.E2, 2, at(2026, 11, 27, 23, 59, 59, 999)),
        ];
        const report = prepareReport({ events, labResults: [] }, selection({ range: '90' }), NOW);
        expect(report.from).toBe('2026-08-30');
        expect(report.to).toBe('2026-11-27');
        expect(report.events.map(e => e.id)).toEqual(['today', 'earliest']);
    });

    it('takes 30 dates: today and the 29 days before it', () => {
        const records: ReportRecords = {
            events: [
                dose('earliest', Route.oral, Ester.E2, 2, at(2026, 10, 29, 0, 0, 0, 0)),
                dose('the-day-before', Route.oral, Ester.E2, 2, at(2026, 10, 28, 23, 59, 59, 999)),
            ],
            labResults: [
                lab('earliest', at(2026, 10, 29, 0, 0, 0, 0), 120, 'pg/ml'),
                lab('the-day-before', at(2026, 10, 28, 23, 59, 59, 999), 120, 'pg/ml'),
            ],
        };
        const report = prepareReport(records, selection({ range: '30' }), NOW);
        expect(report.from).toBe('2026-10-29');
        expect(report.to).toBe('2026-11-27');
        expect(report.events.map(e => e.id)).toEqual(['earliest']);
        expect(report.labResults.map(l => l.id)).toEqual(['earliest']);
    });
});

describe('a medication is its route and its drug', () => {
    it('does not change when the dose size changes', () => {
        const small = dose('small', Route.oral, Ester.E2, 2, 100);
        const large = dose('large', Route.oral, Ester.E2, 4, 101);
        expect(reportMedicationKey(small)).toBe(reportMedicationKey(large));
    });

    it('changes with the route and with the drug', () => {
        const oral = dose('oral', Route.oral, Ester.E2, 2, 100);
        const underTongue = dose('sl', Route.sublingual, Ester.E2, 2, 100);
        const valerate = dose('ev', Route.oral, Ester.EV, 2, 100);
        expect(reportMedicationKey(oral)).not.toBe(reportMedicationKey(underTongue));
        expect(reportMedicationKey(oral)).not.toBe(reportMedicationKey(valerate));
    });

    it('files a patch taken off under the patch it belongs to', () => {
        const applied = dose('on', Route.patchApply, Ester.E2, 0, 100, { [ExtraKey.areaCM2]: 3.75 });
        const removed = dose('off', Route.patchRemove, Ester.E2, 0, 150);
        expect(reportMedicationKey(removed)).toBe(reportMedicationKey(applied));
        const bigger = dose('bigger', Route.patchApply, Ester.E2, 0, 200, { [ExtraKey.areaCM2]: 7.5 });
        expect(reportMedicationKey(bigger)).toBe(reportMedicationKey(applied));
    });
});

describe('the date window is a set of local calendar days', () => {
    const records: ReportRecords = {
        events: [
            dose('first-instant', Route.oral, Ester.E2, 2, at(2026, 11, 1, 0, 0, 0, 0)),
            dose('last-instant', Route.oral, Ester.E2, 2, at(2026, 11, 2, 23, 59, 59, 999)),
            dose('day-before', Route.oral, Ester.E2, 2, at(2026, 10, 31, 23, 59, 59, 999)),
            dose('day-after', Route.oral, Ester.E2, 2, at(2026, 11, 3, 0, 0, 0, 0)),
        ],
        labResults: [],
    };

    it('takes the first day and the last day whole', () => {
        const report = prepareReport(
            records,
            selection({ range: 'custom', from: '2026-11-01', to: '2026-11-02' }),
            NOW,
        );
        expect(report.from).toBe('2026-11-01');
        expect(report.to).toBe('2026-11-02');
        expect(report.events.map(e => e.id)).toEqual(['last-instant', 'first-instant']);
    });

    it('leaves the days outside it out', () => {
        const report = prepareReport(
            records,
            selection({ range: 'custom', from: '2026-11-02', to: '2026-11-02' }),
            NOW,
        );
        expect(report.events.map(e => e.id)).toEqual(['last-instant']);
    });

    it('keeps every row when the range is all time', () => {
        const report = prepareReport(records, selection({ range: 'all' }), NOW);
        expect(report.from).toBeNull();
        expect(report.to).toBeNull();
        expect(report.events).toHaveLength(4);
    });

    it('refuses a custom range that is missing, impossible or backwards', () => {
        const missing = prepareReport(records, selection({ range: 'custom', from: '', to: '2026-11-02' }), NOW);
        expect(missing.invalidRange).toBe(true);
        expect(missing.events).toEqual([]);
        expect(missing.labResults).toEqual([]);

        const impossible = prepareReport(
            records,
            selection({ range: 'custom', from: '2026-02-30', to: '2026-11-02' }),
            NOW,
        );
        expect(impossible.invalidRange).toBe(true);

        const backwards = prepareReport(
            records,
            selection({ range: 'custom', from: '2026-11-05', to: '2026-11-01' }),
            NOW,
        );
        expect(backwards.invalidRange).toBe(true);
        expect(backwards.events).toEqual([]);
    });
});

describe('the local day is the local day, whatever the clocks did', () => {
    afterEach(() => {
        process.env.TZ = 'UTC';
    });

    it('includes the whole of a day a daylight-saving change made shorter', () => {
        process.env.TZ = 'America/New_York';
        // 8 March 2026: the clocks go forward at 02:00, so the day is 23 hours
        // long and ends at 2026-03-09 04:00 UTC.
        const events = [
            dose('start-of-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 2, 8, 5) / HOUR),
            dose('end-of-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 2, 9, 3, 59, 59, 999) / HOUR),
            dose('next-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 2, 9, 4) / HOUR),
        ];
        const report = prepareReport(
            { events, labResults: [] },
            selection({ range: 'custom', from: '2026-03-08', to: '2026-03-08' }),
            NOW,
        );
        expect(report.events.map(e => e.id)).toEqual(['end-of-day', 'start-of-day']);
    });

    it('includes the whole of a day a daylight-saving change made longer', () => {
        process.env.TZ = 'America/New_York';
        // 1 November 2026: the clocks go back at 02:00, so the day is 25 hours
        // long and ends at 2026-11-02 05:00 UTC.
        const events = [
            dose('start-of-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 10, 1, 4) / HOUR),
            dose('end-of-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 10, 2, 4, 59, 59, 999) / HOUR),
            dose('next-day', Route.oral, Ester.E2, 2, Date.UTC(2026, 10, 2, 5) / HOUR),
        ];
        const report = prepareReport(
            { events, labResults: [] },
            selection({ range: 'custom', from: '2026-11-01', to: '2026-11-01' }),
            NOW,
        );
        expect(report.events.map(e => e.id)).toEqual(['end-of-day', 'start-of-day']);
    });

    it.each([
        ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00Z'],
        ['Asia/Beirut', '2026-03-29', '2026-03-28T22:00:00Z'],
        ['America/Havana', '2026-03-08', '2026-03-08T05:00:00Z'],
    ])('includes the first instant of a date with no midnight in %s', (timezone, day, firstInstant) => {
        process.env.TZ = timezone;
        const start = Date.parse(firstInstant);
        expect(new Date(start).getHours()).toBe(1);
        const events = [
            dose('previous-day', Route.oral, Ester.E2, 2, (start - 1) / HOUR),
            dose('start-of-day', Route.oral, Ester.E2, 2, start / HOUR),
            dose('inside-first-hour', Route.oral, Ester.E2, 2, (start + HOUR / 2) / HOUR),
        ];
        const report = prepareReport(
            { events, labResults: [] },
            selection({ range: 'custom', from: day, to: day }),
            NOW,
        );
        expect(report.events.map(e => e.id)).toEqual(['inside-first-hour', 'start-of-day']);
    });
});

describe('the table holds what was asked for', () => {
    const events = [
        dose('oral-2mg', Route.oral, Ester.E2, 2, at(2026, 9, 1, 8)),
        dose('oral-4mg', Route.oral, Ester.E2, 4, at(2026, 9, 2, 8)),
        dose('oral-cpa', Route.oral, Ester.CPA, 10, at(2026, 9, 3, 8)),
        dose('injection-ev', Route.injection, Ester.EV, 10, at(2026, 9, 4, 8)),
    ];

    it('keeps every dose of the medications that were picked', () => {
        const report = prepareReport({ events, labResults: [] }, selection({ medications: ['oral:E2'] }), NOW);
        expect(report.events.map(e => e.id)).toEqual(['oral-4mg', 'oral-2mg']);
    });

    it('keeps a patch and its removal under the one medication', () => {
        const applied = dose('patch-on', Route.patchApply, Ester.E2, 0, at(2026, 9, 1, 8), {
            [ExtraKey.areaCM2]: 3.75,
        });
        const removed = dose('patch-off', Route.patchRemove, Ester.E2, 0, at(2026, 9, 3, 8));
        const report = prepareReport(
            { events: [applied, removed], labResults: [] },
            selection({ medications: ['patchApply:E2'] }),
            NOW,
        );
        expect(report.events.map(e => e.id)).toEqual(['patch-off', 'patch-on']);
    });

    it('takes every medication when none was picked', () => {
        const report = prepareReport({ events, labResults: [] }, selection({ medications: null }), NOW);
        expect(report.events).toHaveLength(4);
    });

    it('lists the rows newest first, as the dose PDF does', () => {
        const shuffled = [...events].reverse();
        const report = prepareReport({ events: shuffled, labResults: [] }, selection(), NOW);
        expect(report.events.map(e => e.id)).toEqual(['injection-ev', 'oral-cpa', 'oral-4mg', 'oral-2mg']);
    });

    it('keeps rows that share a moment in the order they were logged', () => {
        const tied = [
            dose('logged-first', Route.oral, Ester.E2, 2, at(2026, 9, 1, 8)),
            dose('logged-second', Route.oral, Ester.E2, 2, at(2026, 9, 1, 8)),
        ];
        const report = prepareReport({ events: tied, labResults: [] }, selection(), NOW);
        expect(report.events.map(e => e.id)).toEqual(['logged-first', 'logged-second']);
    });
});

describe('the measured graph', () => {
    const records: ReportRecords = {
        events: [],
        labResults: [
            lab('e2-pg', at(2026, 9, 1, 8), 120, 'pg/ml'),
            lab('e2-pmol', at(2026, 9, 2, 8), 367.1, 'pmol/l'),
            lab('t-ng', at(2026, 9, 3, 8), 640, 'ng/dl'),
            lab('t-nmol', at(2026, 9, 4, 8), 10, 'nmol/l'),
        ],
    };

    it('carries no hormone level at all when no graph was asked for', () => {
        const report = prepareReport(records, selection(), NOW);
        expect(report.charts).toEqual([]);
        expect(report.labResults).toHaveLength(4);
    });

    it('plots estradiol in pg/mL and leaves the other hormone out', () => {
        const report = prepareReport(records, selection({ measuredGraph: true, hormones: ['E2'] }), NOW);
        expect(report.labResults.map(l => l.id)).toEqual(['e2-pmol', 'e2-pg']);
        const chart = report.charts.find(c => c.kind === 'measured');
        expect(chart?.hormone).toBe('E2');
        expect(chart?.unit).toBe('pg/mL');
        expect(chart?.points).toHaveLength(2);
        expect(chart?.points[0]).toEqual({ timeH: at(2026, 9, 1, 8), value: 120 });
        expect(chart?.points[1].timeH).toBe(at(2026, 9, 2, 8));
        expect(chart?.points[1].value).toBeCloseTo(100, 6);
    });

    it('plots testosterone in ng/dL', () => {
        const report = prepareReport(records, selection({ measuredGraph: true, hormones: ['T'] }), NOW);
        const chart = report.charts.find(c => c.kind === 'measured');
        expect(chart?.hormone).toBe('T');
        expect(chart?.unit).toBe('ng/dL');
        expect(chart?.points[0]).toEqual({ timeH: at(2026, 9, 3, 8), value: 640 });
        expect(chart?.points[1].value).toBeCloseTo(288.42, 6);
    });
});

describe('the estimated graph', () => {
    it('draws the Overview line, calibrated, and stops at the present', () => {
        const { estimate } = estimateSource();
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        const chart = report.charts.find(c => c.kind === 'estimated');
        expect(chart?.hormone).toBe('E2');
        expect(chart?.unit).toBe('pg/mL');
        // The samples inside the window, and the present read between the
        // samples at 190 and 210. The present is read from the calibrated
        // values (16 and 25), not from the raw ones scaled afterwards.
        expect(chart?.points).toEqual([
            { timeH: 100, value: 1 },
            { timeH: 110, value: 4 },
            { timeH: 120, value: 9 },
            { timeH: 190, value: 16 },
            { timeH: 200, value: 20.5 },
        ]);
    });

    it('reads the calibration only at the model own sample times', () => {
        const { estimate, calls } = estimateSource();
        prepareReport({ events: [], labResults: [] }, selection({ range: 'all', estimatedGraph: true }), NOW, estimate);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(time => SAMPLE_TIMES.includes(time))).toBe(true);
        // Neither the present nor anything past it is asked about.
        expect(calls).not.toContain(200);
        expect(calls).not.toContain(300);
    });

    it('keeps the last plotted instant inside the selected calendar day', () => {
        const { estimate } = estimateSource({ calibrationFn: () => 1 });
        const start = new Date(2026, 10, 2).getTime();
        const end = new Date(2026, 10, 3).getTime();
        estimate.simulation.timeH = [start - HOUR, start, start + HOUR, end - HOUR, end, end + HOUR].map(t => t / HOUR);
        estimate.nowH = NOW.getTime() / HOUR;
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'custom', from: '2026-11-02', to: '2026-11-02', estimatedGraph: true }),
            NOW,
            estimate,
        );
        const points = report.charts[0].points;
        expect(points[0].timeH).toBe(start / HOUR);
        expect(points[points.length - 1].timeH).toBe((end - 1) / HOUR);
    });

    it('does not request calibration before the exact first sample of the selected date', () => {
        const startH = new Date(2026, 10, 2).getTime() / HOUR;
        const { estimate } = estimateSource({
            calibrationFn: h => {
                if (h < startH) throw new Error('Model sample unavailable.');
                return 1;
            },
            nowH: startH + 3,
        });
        estimate.simulation.timeH = [startH - 1, startH, startH + 1, startH + 2, startH + 3, startH + 4];
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'custom', from: '2026-11-02', to: '2026-11-02', estimatedGraph: true }),
            NOW,
            estimate,
        );
        expect(report.charts[0]?.points).toEqual([
            { timeH: startH, value: 2 },
            { timeH: startH + 1, value: 3 },
            { timeH: startH + 2, value: 4 },
            { timeH: startH + 3, value: 5 },
        ]);
    });

    it('omits an estimate when a calibrated level is not finite', () => {
        const { estimate } = estimateSource({ calibrationFn: () => Number.MAX_VALUE });
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        expect(report.charts).toEqual([]);
    });

    it('draws nothing past the present', () => {
        const { estimate } = estimateSource();
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        const chart = report.charts.find(c => c.kind === 'estimated');
        expect(chart?.points[chart?.points.length - 1].timeH).toBe(200);
    });

    it('bounds a long curve without losing a peak introduced by calibration', () => {
        const times = Array.from({ length: 2000 }, (_, i) => 100 + i);
        const simulation: SimulationResult = {
            timeH: times,
            concPGmL: times.map(() => 0),
            concPGmL_E2: times.map((_, i) => (i === 1233 ? 10 : 1)),
            concPGmL_CPA: times.map(() => 0),
            concPGmL_BICA: times.map(() => 0),
            concNGdL_T: times.map(() => 0),
            auc: 0,
        };
        const estimate: ReportEstimateSource = {
            mode: 'transfem',
            events: [dose('e2-dose', Route.oral, Ester.E2, 2, 100)],
            simulation,
            calibrationFn: hour => (hour === times[1234] ? 999 : 1),
            nowH: 2100,
        };
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        const points = report.charts.find(c => c.kind === 'estimated')?.points ?? [];
        expect(points.length).toBeLessThanOrEqual(400);
        expect(points).toContainEqual({ timeH: times[1234], value: 999 });
        expect(points[0].timeH).toBe(100);
        expect(points[points.length - 1].timeH).toBe(2099);
    });

    it('estimates total testosterone without a calibration', () => {
        const { estimate, calls } = estimateSource({
            mode: 'transmasc',
            events: [dose('t-dose', Route.injection, Ester.TE, 100, 100)],
        });
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true, hormones: ['T'] }),
            NOW,
            estimate,
        );
        expect(calls).toEqual([]);
        const chart = report.charts.find(c => c.kind === 'estimated');
        expect(chart?.hormone).toBe('T');
        expect(chart?.unit).toBe('ng/dL');
        expect(chart?.points).toEqual([
            { timeH: 100, value: 10 },
            { timeH: 110, value: 20 },
            { timeH: 120, value: 30 },
            { timeH: 190, value: 40 },
            { timeH: 200, value: 45 },
        ]);
    });

    it('estimates the active mode hormone only, and only when it was asked for', () => {
        const { estimate } = estimateSource();
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true, hormones: ['T'] }),
            NOW,
            estimate,
        );
        expect(report.charts.filter(c => c.kind === 'estimated')).toEqual([]);
    });

    it('draws no estradiol for a history of cyproterone alone', () => {
        const { estimate } = estimateSource({ events: [dose('cpa', Route.oral, Ester.CPA, 10, 100)] });
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        expect(report.charts).toEqual([]);
    });

    it('draws no estradiol for a history of drugs with no level model', () => {
        const { estimate } = estimateSource({ events: [dose('spiro', Route.oral, Ester.SPIRO, 100, 100)] });
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
            estimate,
        );
        expect(report.charts).toEqual([]);
    });

    it('estimates from the whole dose history, whatever the table was filtered to', () => {
        const { estimate } = estimateSource();
        const report = prepareReport(
            { events: [dose('oral-e2', Route.oral, Ester.E2, 2, at(2026, 9, 1, 8))], labResults: [] },
            selection({ range: 'all', estimatedGraph: true, medications: ['injection:EV'] }),
            NOW,
            estimate,
        );
        expect(report.events).toEqual([]);
        expect(report.charts.find(c => c.kind === 'estimated')).toBeDefined();
    });

    it('draws nothing when no model was handed over', () => {
        const report = prepareReport(
            { events: [], labResults: [] },
            selection({ range: 'all', estimatedGraph: true }),
            NOW,
        );
        expect(report.charts).toEqual([]);
    });
});

describe('the report is a copy, not a claim on what it was given', () => {
    it('changes nothing it was given', () => {
        const records: ReportRecords = {
            events: [
                dose('oral', Route.oral, Ester.E2, 2, at(2026, 9, 2, 8)),
                dose('oral-earlier', Route.oral, Ester.E2, 2, at(2026, 9, 1, 8)),
            ],
            labResults: [lab('e2', at(2026, 9, 1, 8), 120, 'pg/ml')],
        };
        const recordsBefore = structuredClone(records);
        const chosen = selection({ medications: ['oral:E2'], measuredGraph: true, estimatedGraph: true });
        const chosenBefore = structuredClone(chosen);
        const { estimate } = estimateSource();
        const simulationBefore = structuredClone(estimate.simulation);

        const report = prepareReport(records, chosen, NOW, estimate);

        expect(records).toEqual(recordsBefore);
        expect(chosen).toEqual(chosenBefore);
        expect(estimate.simulation).toEqual(simulationBefore);
        expect(report.selection).not.toBe(chosen);
        expect(report.selection).toEqual(chosen);
    });
});
