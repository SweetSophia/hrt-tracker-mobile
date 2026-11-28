import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { Ester, Route, type DoseEvent, type LabResult, type SimulationResult } from '../logic';
import { TRANSLATIONS } from '../src/i18n/translations';
import type { Lang } from '../src/i18n/languages';
import { defaultReportSelection, prepareReport } from '../src/reports/prepareReport';
import type { PreparedReport, ReportChart, ReportEstimateSource, ReportSelection } from '../src/reports/types';
import { buildReportDocument, saveReport } from '../src/reports/pdf';
import { formatTickNumber, medicationLabel, reportLocale } from '../src/reports/labels';
import { buildDomain } from '../src/reports/chartScale';
import { drawChart } from '../src/reports/pdf/charts';
import { drawParagraph, paragraphHeight } from '../src/reports/pdf/draw';
import { reportFontCharacters } from '../src/reports/pdf/charset';
import { MAX_DOCUMENT_BYTES, type FileSaveRequest } from '../src/platform/contracts/files';
import { reportText } from './helpers/reportText';

const HOUR = 3600000;
const at = (iso: string) => Date.parse(iso) / HOUR;
const NOW = new Date('2026-02-10T12:00:00.000Z');

const events: DoseEvent[] = [
    { id: 'oral', route: Route.oral, ester: Ester.E2, timeH: at('2026-01-05T08:00:00Z'), doseMG: 2, extras: {} },
    {
        id: 'injection',
        route: Route.injection,
        ester: Ester.EV,
        timeH: at('2026-01-12T08:00:00Z'),
        doseMG: 5,
        extras: {},
    },
    {
        id: 'patch-on',
        route: Route.patchApply,
        ester: Ester.E2,
        timeH: at('2026-01-19T08:00:00Z'),
        doseMG: 0.1,
        extras: { releaseRateUGPerDay: 100 },
    },
    {
        id: 'patch-off',
        route: Route.patchRemove,
        ester: Ester.E2,
        timeH: at('2026-01-26T08:00:00Z'),
        doseMG: 0.1,
        extras: { releaseRateUGPerDay: 100 },
    },
    { id: 'gel', route: Route.gel, ester: Ester.E2, timeH: at('2026-02-02T08:00:00Z'), doseMG: 1, extras: {} },
    {
        id: 'older-record',
        route: Route.sublingual,
        ester: Ester.E2,
        timeH: at('2025-11-02T08:00:00Z'),
        doseMG: 1,
        // A record written before the form carried its route extras.
    } as DoseEvent,
];

const labResults: LabResult[] = [
    { id: 'lab-a', timeH: at('2026-01-08T09:00:00Z'), concValue: 95.37, unit: 'pg/ml' },
    { id: 'lab-b', timeH: at('2026-01-20T09:00:00Z'), concValue: 412.5, unit: 'pmol/l' },
    { id: 'lab-c', timeH: at('2026-02-05T09:00:00Z'), concValue: 380, unit: 'ng/dl' },
];

/** A stand-in for the Overview model's own curve. */
const estimate = (): ReportEstimateSource => {
    const timeH: number[] = [];
    const concPGmL_E2: number[] = [];
    const concNGdL_T: number[] = [];
    const start = at('2026-01-01T00:00:00Z');
    const end = NOW.getTime() / HOUR;
    for (let time = start; time <= end; time += 6) {
        timeH.push(time);
        concPGmL_E2.push(180 + 90 * Math.sin((time - start) / 120));
        concNGdL_T.push(400 + 60 * Math.cos((time - start) / 150));
    }
    const simulation = { timeH, concPGmL_E2, concNGdL_T } as unknown as SimulationResult;
    return {
        mode: 'transfem',
        events,
        simulation,
        calibrationFn: () => 1,
        nowH: end,
    };
};

const selection = (overrides: Partial<ReportSelection> = {}): ReportSelection => ({
    ...defaultReportSelection(),
    ...overrides,
});

const prepared = (overrides: Partial<ReportSelection> = {}, withEstimate = false): PreparedReport =>
    prepareReport({ events, labResults }, selection(overrides), NOW, withEstimate ? estimate() : undefined);

const translator = (lang: Lang) => (key: string) => (TRANSLATIONS[lang] as Record<string, string>)[key] ?? key;

const render = async (report: PreparedReport, lang: Lang, t = translator(lang)): Promise<string> => {
    const doc = await buildReportDocument(report, lang, t, NOW);
    return reportText(new Uint8Array(doc.output('arraybuffer')));
};

describe('report PDF', () => {
    it('keeps distinct tick labels when a historical curve is close to zero', () => {
        expect(formatTickNumber('en', 0.00002)).toBe('0.00002');
        expect(formatTickNumber('de', 0.00004)).toBe('0,00004');
        expect(formatTickNumber('en', 0.1 + 0.2)).toBe('0.3');
    });

    it('names the days it covers, the records it holds and the units they were reported in', async () => {
        const text = await render(prepared(), 'en');
        expect(text).toContain('HRT Tracker report');
        expect(text).toContain('Date range');
        expect(text).toContain('Dose history');
        expect(text).toContain('Lab results');
        expect(text).toContain('95.37');
        expect(text).toContain('pg/mL');
        expect(text).toContain('412.5');
        expect(text).toContain('pmol/L');
        expect(text).toContain('380');
        expect(text).toContain('ng/dL');
    });

    it('counts what it holds', async () => {
        const text = await render(prepared(), 'en');
        expect(text).toContain('Dose entries: 5 · Lab results: 3');
    });

    it('includes recorded assay methods only when the selected labs have one', async () => {
        const labs: LabResult[] = [{ ...labResults[0], assay: 'lcms' }, labResults[2]];
        const mixed = prepareReport({ events: [], labResults: labs }, selection(), NOW);
        const text = await render(mixed, 'en');
        expect(text).toContain('Test method');
        expect(text).toContain('LC-MS/MS');

        const testosterone = prepareReport({ events: [], labResults: labs }, selection({ hormones: ['T'] }), NOW);
        const filteredText = await render(testosterone, 'en');
        expect(filteredText).not.toContain('Test method');
        expect(filteredText).not.toContain('LC-MS/MS');
    });

    it('keeps the units the labs used and does not convert them', async () => {
        const text = await render(prepared(), 'en');
        expect(text).not.toContain('154.9');
        expect(text).toContain('pmol/L');
    });

    it('writes a patch as its daily rate and a removal as a removal', async () => {
        const text = await render(prepared(), 'en');
        expect(text).toContain('100 µg/day');
        expect(text).toContain('Patch remove');
    });

    it('numbers its pages', async () => {
        const text = await render(prepared(), 'en');
        expect(text).toMatch(/Page 1 \/ 1/);
    });

    it('repeats the table header on every page of a long report', async () => {
        const many = Array.from({ length: 120 }, (_, index) => ({
            id: 'dose-' + index,
            route: Route.oral,
            ester: Ester.E2,
            timeH: at('2026-01-05T08:00:00Z') + index * 6,
            doseMG: 2,
            extras: {},
        }));
        const long = prepareReport({ events: many, labResults }, selection(), NOW);
        const text = await render(long, 'en');
        const pages = (text.match(/Page \d+ \/ \d+/g) ?? []).length;
        expect(pages).toBeGreaterThan(1);
        // The table's own header row comes back on every page; the section
        // heading above it does not.
        expect((text.match(/^Medication$/gm) ?? []).length).toBe(pages);
    });

    it('draws the measured curve and the estimate apart, with the hint on the estimate', async () => {
        const report = prepared({ measuredGraph: true, estimatedGraph: true }, true);
        const text = await render(report, 'en');
        expect(text).toContain('Measured lab results');
        expect(text).toContain('Estimated hormone level');
        expect(text).toContain("the active mode's complete dose history");
    });

    it('keeps the graphs heading with the first chart and its note', async () => {
        const report = prepared({ estimatedGraph: true }, true);
        const en = translator('en');
        // Leave room for a heading at the bottom of page one, but no room for a chart.
        const text = await render(report, 'en', key =>
            key === 'report.medications' ? 'Medication details\n'.repeat(45) + en(key) : en(key),
        );
        const [firstPage, secondPage] = text.split(/^Page \d+ \/ \d+$/m);
        expect(firstPage).toContain('Graphs · Estradiol (Estimated hormone level)');
        expect(firstPage).not.toMatch(/^Graphs$/m);
        expect(secondPage).toMatch(/^Graphs$/m);
        expect(secondPage).toMatch(/^Estimated hormone level$/m);
        expect(secondPage).toContain("the active mode's complete dose history");
    });

    it('says when a curve was asked for and cannot be drawn', async () => {
        const text = await render(prepared({ estimatedGraph: true }), 'en');
        expect(text).toContain('No hormone estimate is available');
        expect(text).not.toContain('Estimated hormone level');
    });

    it('says so when the report holds nothing', async () => {
        const empty = prepareReport({ events: [], labResults: [] }, selection(), NOW);
        const text = await render(empty, 'en');
        expect(text).toContain('No records or graphs match your selection.');
    });

    it('says so when the range is not a range', async () => {
        const broken = prepareReport(
            { events, labResults },
            selection({ range: 'custom', from: '2026-02-10', to: '2026-01-01' }),
            NOW,
        );
        expect(broken.invalidRange).toBe(true);
        const text = await render(broken, 'en');
        expect(text).toContain('Choose a valid start and end date.');
    });

    it('reports both modes only when both were asked for', async () => {
        const one = await render(prepared(), 'en');
        expect(one).not.toContain('Include records from both HRT modes');
        const both = await render(prepared({ bothModes: true }), 'en');
        expect(both).toContain('Records from both HRT modes');
    });

    it('writes the report in the language it was asked for', async () => {
        const ja = await render(prepared(), 'ja');
        expect(ja).toContain('投薬記録');
        expect(ja).toContain('検査結果');
        const ko = await render(prepared(), 'ko');
        expect(ko).toContain('복용 기록');
        expect(ko).toContain('검사 결과');
        const zh = await render(prepared(), 'zh');
        expect(zh).toContain('用药记录');
        expect(zh).toContain('检查记录');
        const ru = await render(prepared(), 'ru');
        expect(ru).toContain('Доза');
    });

    it('hands real PDF bytes to the file port', async () => {
        let request: FileSaveRequest | undefined;
        const result = await saveReport(
            prepared(),
            'en',
            translator('en'),
            {
                save: next => {
                    request = next;
                    return Promise.resolve('saved');
                },
            },
            NOW,
        );
        expect(result).toBe('saved');
        expect(request?.name).toBe('hrt-report-2026-02-10.pdf');
        expect(request?.mimeType).toBe('application/pdf');
        expect(Buffer.from(request!.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        expect(request!.bytes.byteLength).toBeLessThan(MAX_DOCUMENT_BYTES);
    });

    it('leaves out the records the selection excluded', async () => {
        const report = prepared({ medications: ['oral:E2'] });
        const text = await render(report, 'en');
        expect(text).toContain('Oral estradiol');
        expect(text).not.toContain('Estradiol valerate injection');
        expect(text).not.toContain('Estradiol gel');
        expect(text).not.toContain('Estradiol patch');
        expect(text).not.toContain('synthetic-dose');
    });

    it('writes the numbers the way the language writes them', async () => {
        const labs: LabResult[] = [{ id: 'small', timeH: at('2026-01-08T09:00:00Z'), concValue: 5.25, unit: 'pg/ml' }];
        const report = prepareReport({ events: [], labResults: labs }, selection({ measuredGraph: true }), NOW);
        const turkish = await render(report, 'tr');
        expect(turkish).toContain('5,25');
        expect(turkish).not.toContain('5.25');
        const english = await render(report, 'en');
        expect(english).toContain('5.25');
    });

    it('keeps the file small enough to send', async () => {
        const doc = await buildReportDocument(prepared(), 'en', translator('en'), NOW);
        const bytes = new Uint8Array(doc.output('arraybuffer'));
        expect(bytes.byteLength).toBeLessThan(150 * 1024);
    });

    it('gives every chart on the page the same window', async () => {
        const labs: LabResult[] = [
            { id: 'e2a', timeH: at('2025-11-05T09:00:00Z'), concValue: 80, unit: 'pg/ml' },
            { id: 'e2b', timeH: at('2025-11-20T09:00:00Z'), concValue: 120, unit: 'pg/ml' },
            { id: 'ta', timeH: at('2025-11-01T09:00:00Z'), concValue: 300, unit: 'ng/dl' },
            { id: 'tb', timeH: at('2025-11-27T09:00:00Z'), concValue: 500, unit: 'ng/dl' },
        ];
        const report = prepareReport(
            { events: [], labResults: labs },
            selection({ range: 'custom', from: '2025-11-01', to: '2025-11-30', measuredGraph: true }),
            NOW,
        );
        const text = await render(report, 'en');
        const lines = text.split('\n');
        // Both curves run from the first sample to the last, so both axes name
        // the same days: the estradiol curve's own window would be Nov 5-20.
        expect(lines.filter(line => line === 'Nov 1').length).toBe(2);
        expect(lines.filter(line => line === 'Nov 27').length).toBe(2);
        // Each point's number stands on its own line, inside the plot: two
        // numbers that ran into each other would read as one.
        expect(lines.filter(line => line === '80').length).toBeGreaterThanOrEqual(1);
        expect(lines.filter(line => line === '120').length).toBeGreaterThanOrEqual(1);
        expect(lines.some(line => /^\d+\.\d+\.\d+$/.test(line))).toBe(false);
    });

    it('does not claim a lab measurement when the report holds only an estimate', async () => {
        const report = prepareReport(
            { events, labResults: [] },
            selection({ measuredGraph: false, estimatedGraph: true }),
            NOW,
            estimate(),
        );
        const text = await render(report, 'en');
        expect(text).toContain('Lab measurements · None');
        expect(text).toContain('Graphs · Estradiol (Estimated hormone level)');
        expect(text).toContain('Estimated hormone level');
    });

    it('keeps the decimals a dose was recorded with', async () => {
        const doses: DoseEvent[] = [
            {
                id: 'precise',
                route: Route.oral,
                ester: Ester.E2,
                timeH: at('2026-01-05T08:00:00Z'),
                doseMG: 0.125,
                extras: {},
            },
            {
                id: 'tiny',
                route: Route.sublingual,
                ester: Ester.E2,
                timeH: at('2026-01-06T08:00:00Z'),
                doseMG: 0.004,
                extras: {},
            },
            {
                id: 'rate',
                route: Route.patchApply,
                ester: Ester.E2,
                timeH: at('2026-01-07T08:00:00Z'),
                doseMG: 0.1,
                extras: { releaseRateUGPerDay: 12.5 },
            },
        ];
        const report = prepareReport({ events: doses, labResults: [] }, selection(), NOW);
        const text = await render(report, 'en');
        expect(text).toContain('0.125 mg');
        expect(text).toContain('0.004 mg');
        expect(text).toContain('12.5 µg/day');
        expect(text).not.toContain('0.13 mg');
        expect(text).not.toContain('0.00 mg');
    });

    it('writes a measured point with the digits it was measured to', async () => {
        const text = await render(prepared({ measuredGraph: true }), 'en');
        const lines = text.split('\n');
        // 95.37 pg/mL is not 95.
        expect(lines).toContain('95.37');
        // A value the unit conversion moved is marked as an approximation.
        expect(lines.some(line => line.startsWith('~'))).toBe(true);
    });

    it('puts two plots of one hormone on the same scale', async () => {
        const report = prepared({ measuredGraph: true, estimatedGraph: true }, true);
        const lines = (await render(report, 'en')).split('\n');
        // The measured curve and the estimate of estradiol share an axis, so
        // the top of that axis is named by both of them.
        expect(lines.filter(line => line === '300').length).toBe(2);
    });

    it('omits unscalable graphs from the contents and keeps valid estimates and lab rows', async () => {
        const huge: LabResult[] = [
            { id: 'huge', timeH: at('2026-01-08T09:00:00Z'), concValue: Number.MAX_VALUE, unit: 'pg/ml' },
            { id: 'close', timeH: at('2026-01-09T09:00:00Z'), concValue: 1e16, unit: 'pg/ml' },
            { id: 'closer', timeH: at('2026-01-10T09:00:00Z'), concValue: 1e16 + 2, unit: 'pg/ml' },
        ];
        const records = { events, labResults: huge };
        const report = prepareReport(records, selection({ measuredGraph: true }), NOW);
        expect(report.charts).toEqual([]);
        // The graph was asked for and there is one to draw. Its values are
        // what no axis can hold, which is not the same as there being nothing
        // to draw.
        expect(report.unplottableCharts.map(chart => chart.kind)).toEqual(['measured']);
        // The records behind it are kept: one impossible number is not a
        // reason to leave them out of the report.
        expect(report.labResults).toHaveLength(3);
        const text = await render(report, 'en');
        expect(text).toMatch(/^Lab results$/m);
        expect(text).toContain('Graphs · None');
        expect(text).toContain('No matching lab results can be graphed.');
        expect(text).not.toMatch(/^Graphs$/m);

        const mixed = prepareReport(records, selection({ measuredGraph: true, estimatedGraph: true }), NOW, estimate());
        expect(mixed.charts.map(chart => chart.kind)).toEqual(['estimated']);
        const mixedText = await render(mixed, 'en');
        expect(mixedText).toContain('Graphs · Estradiol (Estimated hormone level)');
        expect(mixedText).toMatch(/^Estimated hormone level$/m);
        expect(mixedText).toContain('No matching lab results can be graphed.');
        expect(mixedText).toMatch(/^Lab results$/m);
    });

    it('tells a graph with nothing to show from one that cannot be drawn', async () => {
        // Nothing matched the graph: there is nothing to draw and nothing
        // that failed to draw.
        const absent = prepareReport({ events, labResults: [] }, selection({ measuredGraph: true }), NOW);
        expect(absent.charts).toEqual([]);
        expect(absent.unplottableCharts).toEqual([]);

        // One measured value no axis can hold. The record is still a record,
        // and the report says in the same words that it cannot be graphed.
        const unplottable = prepareReport(
            {
                events,
                labResults: [
                    { id: 'huge', timeH: at('2026-01-08T09:00:00Z'), concValue: Number.MAX_VALUE, unit: 'pg/ml' },
                ],
            },
            selection({ measuredGraph: true }),
            NOW,
        );
        expect(unplottable.charts).toEqual([]);
        expect(unplottable.unplottableCharts.map(chart => chart.kind)).toEqual(['measured']);
        expect(unplottable.labResults).toHaveLength(1);

        const absentText = await render(absent, 'en');
        const unplottableText = await render(unplottable, 'en');
        expect(absentText).toContain('No matching lab results can be graphed.');
        expect(unplottableText).toContain('No matching lab results can be graphed.');
        // The record is in the document, value and all. The value is written
        // in a narrow column, so it is read back with the line break taken out.
        expect(unplottableText.replace(/\n/g, '')).toContain('1.7976931348623157e+308');
        expect(unplottableText).toMatch(/^Lab results$/m);
    });
});

/** A point in points is this many millimetres. */
const PT_TO_MM = 25.4 / 72;

/** A paragraph long enough to wrap in a narrow column. */
const LONG_TEXT =
    'This is a long paragraph of report text that is meant to wrap over several lines when the column ' +
    'is narrow enough to force it, and the number of lines it takes must be measured rather than guessed.';

describe('report PDF layout', () => {
    it('wraps a paragraph at the size it is drawn at', () => {
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        // The size an earlier drawing left behind.
        doc.setFontSize(8);
        const drawn = vi.spyOn(doc, 'text');
        const height = drawParagraph(doc, LONG_TEXT, 16, 20, { size: 9, maxWidth: 178, lineHeight: 1.3 });
        const lines = drawn.mock.calls[0][0] as string[];
        expect(lines.length).toBeGreaterThan(1);
        // Every line fits the column at the size the paragraph is drawn at: a
        // line that does not fit takes more rows than the room measured for
        // it, and the block under it is covered.
        doc.setFontSize(9);
        for (const line of lines) {
            expect(doc.getTextWidth(line)).toBeLessThanOrEqual(178);
        }
        // The room reserved is the room the lines take.
        expect(lines.length * 9 * 1.3 * PT_TO_MM).toBeCloseTo(height, 5);
    });

    it('measures a paragraph at the size it is given', () => {
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        doc.setFontSize(9);
        const measured = paragraphHeight(doc, LONG_TEXT, 9, 50);
        // The same paragraph, measured with a different size in the document.
        doc.setFontSize(8);
        expect(paragraphHeight(doc, LONG_TEXT, 9, 50)).toBe(measured);
    });

    it('keeps a negative measurement inside the chart', () => {
        const domain = buildDomain(-5, 100);
        expect(domain).not.toBeNull();
        expect(domain![0]).toBeLessThanOrEqual(-5);
        expect(domain![1]).toBeGreaterThanOrEqual(100);
        const onlyNegative = buildDomain(-5, -2);
        expect(onlyNegative).not.toBeNull();
        expect(onlyNegative![0]).toBeLessThanOrEqual(-5);
        expect(onlyNegative![1]).toBeGreaterThanOrEqual(-2);
        // A quantity that never went below zero keeps the axis it always had.
        expect(buildDomain(80, 120)).toEqual([70, 130]);

        const chart: ReportChart = {
            kind: 'measured',
            hormone: 'E2',
            unit: 'pg/mL',
            points: [
                { timeH: at('2026-01-08T09:00:00Z'), value: -5 },
                { timeH: at('2026-01-20T09:00:00Z'), value: 100 },
            ],
        };
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const circles = vi.spyOn(doc, 'circle');
        const lines = vi.spyOn(doc, 'line');
        drawChart(doc, chart, {
            lang: 'en',
            t: translator('en'),
            x: 16,
            y: 20,
            width: 178,
            series: 'Measured lab results',
            domain: domain!,
        });
        // The points run in time order, so the first circle is the negative
        // measurement, and a value below zero is drawn lower on the page.
        const negative = circles.mock.calls[0];
        expect(negative[1]).toBeGreaterThan(circles.mock.calls[1][1]);
        // The value axis is the tallest upright line the chart drew, and the
        // point has to stand between its ends.
        const axis = lines.mock.calls
            .filter(call => call[0] === call[2])
            .sort((a, b) => Math.abs(b[3] - b[1]) - Math.abs(a[3] - a[1]))[0];
        expect(axis).toBeDefined();
        expect(negative[1]).toBeGreaterThanOrEqual(Math.min(axis![1], axis![3]));
        expect(negative[1]).toBeLessThanOrEqual(Math.max(axis![1], axis![3]));
    });

    it('orders the medications by the language the report is written in', async () => {
        const report = prepared();
        const names = [...new Set(report.events.map(event => medicationLabel(event, translator('zh'))))];
        const byReport = [...names].sort((a, b) => a.localeCompare(b, reportLocale('zh')));
        const byEnglish = [...names].sort((a, b) => a.localeCompare(b, 'en-US'));
        // The two orders have to differ, or the report would say nothing about
        // which locale was used.
        expect(byReport).not.toEqual(byEnglish);
        const text = await render(report, 'zh');
        const line = text.split('\n').find(candidate => byReport.every(name => candidate.includes(name)));
        expect(line).toBeDefined();
        const positions = byReport.map(name => line!.indexOf(name));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('refuses a report whose table did not come out', async () => {
        vi.resetModules();
        vi.doMock('jspdf-autotable', async importOriginal => {
            const actual = await importOriginal<typeof import('jspdf-autotable')>();
            return {
                ...actual,
                autoTable: (doc: jsPDF, options: Parameters<typeof actual.autoTable>[1]) => {
                    actual.autoTable(doc, options);
                    // The layout did not come out.
                    const table = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable;
                    if (table) table.finalY = undefined;
                },
            };
        });
        try {
            const failing = await import('../src/reports/pdf');
            await expect(failing.buildReportDocument(prepared(), 'en', translator('en'), NOW)).rejects.toThrow(
                'A table in the report did not finish drawing.',
            );
        } finally {
            vi.doUnmock('jspdf-autotable');
            vi.resetModules();
        }
    });
});

describe('report fonts', () => {
    const manifestPath = fileURLToPath(new URL('../src/reports/fonts/manifest.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        fonts: Record<string, { file: string; langs: string[]; sha256: string; bytes: number }>;
        charsets: Record<string, string>;
    };

    it('covers every character the report can draw', () => {
        for (const lang of Object.keys(manifest.charsets)) {
            expect(reportFontCharacters(lang as Lang)).toBe(manifest.charsets[lang]);
        }
    });

    it('ships a font for every language', () => {
        const covered = new Set(Object.values(manifest.fonts).flatMap(font => font.langs));
        expect([...covered].sort()).toEqual(Object.keys(manifest.charsets).sort());
    });

    it('ships the exact font files listed in the manifest with every required glyph', () => {
        const { TTFFont } = jsPDF.API as typeof jsPDF.API & {
            TTFFont: { open(data: Uint8Array): { characterToGlyph(codePoint: number): number } };
        };
        for (const font of Object.values(manifest.fonts)) {
            const path = fileURLToPath(new URL('../src/reports/fonts/' + font.file, import.meta.url));
            const bytes = readFileSync(path);
            expect(bytes.byteLength).toBe(font.bytes);
            expect(createHash('sha256').update(bytes).digest('hex'), font.file).toBe(font.sha256);
            const parsed = TTFFont.open(bytes);
            for (const lang of font.langs) {
                const missing = [...manifest.charsets[lang]].filter(
                    char => parsed.characterToGlyph(char.codePointAt(0)!) === 0,
                );
                expect(missing, lang).toEqual([]);
            }
        }
    });

    it('rejects a font imported as an asset URL', async () => {
        const path = '../src/reports/fonts/NotoSans-Latin.ttf?inline';
        vi.resetModules();
        vi.doMock(path, () => ({ default: '/assets/NotoSans-Latin.ttf' }));
        try {
            const { loadReportFont } = await import('../src/reports/pdf/fonts');
            await expect(loadReportFont('en')).rejects.toThrow('Invalid bundled report font for en.');
        } finally {
            vi.doUnmock(path);
            vi.resetModules();
        }
    });

    it('keeps the embedded font small enough to send', () => {
        for (const font of Object.values(manifest.fonts)) {
            expect(font.bytes).toBeLessThan(120 * 1024);
        }
    });
});
