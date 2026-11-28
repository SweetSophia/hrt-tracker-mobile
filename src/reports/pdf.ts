import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { isLabAssay } from '../../logic';
import {
    DocumentTooLargeError,
    MAX_DOCUMENT_BYTES,
    type FileSavePort,
    type FileSaveResult,
} from '../platform/contracts/files';
import type { Lang } from '../i18n/languages';
import {
    doseLabel,
    formatDay,
    formatDayTime,
    hormoneLabel,
    labHormone,
    labUnitLabel,
    labValueLabel,
    localDate,
    medicationLabel,
    parseCalendarDay,
    reportLocale,
    resetReportDateFormatters,
    routeLabel,
    type T,
} from './labels';
import type { PreparedReport, ReportChart } from './types';
import { fill } from '../utils/regimenText';
import { toDayKey } from '../utils/helpers';
import { loadReportFont, REPORT_FONT_NAME } from './pdf/fonts';
import { chartHeight, drawChart } from './pdf/charts';
import { ACCENT_RULE, COLORS, PAGE, TYPE, type Rgb } from './pdf/theme';
import { drawLine, drawParagraph, drawRect, drawText, paragraphHeight } from './pdf/draw';

export type { FileSavePort, FileSaveResult };

/** The file a report is written to. */
const fileName = (generatedAt: Date): string => `hrt-report-${toDayKey(generatedAt)}.pdf`;

/** The hormones the report names, in the order the app lists them. */
const HORMONE_ORDER = ['E2', 'T'] as const;

const listFormat = (lang: Lang): Intl.ListFormat => new Intl.ListFormat(reportLocale(lang));

/**
 * The window every chart on the page shares.
 *
 * Two charts with two different windows cannot be read against each other: the
 * same place on the two axes would be two different days. One window for the
 * whole page fixes that, and the window is the first and last sample the
 * charts actually show.
 */
const chartBounds = (charts: readonly ReportChart[]): { fromH: number; toH: number } | undefined => {
    let fromH = Number.POSITIVE_INFINITY;
    let toH = Number.NEGATIVE_INFINITY;
    for (const chart of charts) {
        for (const point of chart.points) {
            if (!Number.isFinite(point.timeH)) continue;
            fromH = Math.min(fromH, point.timeH);
            toH = Math.max(toH, point.timeH);
        }
    }
    return Number.isFinite(fromH) && Number.isFinite(toH) ? { fromH, toH } : undefined;
};

/** The date range as the reader sees it: the local days the report covers. */
const rangeLabel = (report: PreparedReport, lang: Lang, t: T): string => {
    if (report.from && report.to) {
        return formatDay(lang, parseCalendarDay(report.from)) + ' – ' + formatDay(lang, parseCalendarDay(report.to));
    }
    if (report.from) return formatDay(lang, parseCalendarDay(report.from)) + ' –';
    if (report.to) return '– ' + formatDay(lang, parseCalendarDay(report.to));
    return t('report.all_time');
};

/** The medications the report's rows are about, named the way the options name them. */
const medicationNames = (report: PreparedReport, lang: Lang, t: T): string[] => {
    const names = new Map<string, string>();
    for (const event of report.events) {
        const label = medicationLabel(event, t);
        if (!names.has(label)) names.set(label, label);
    }
    // The names are in the report's own language, so they are ordered by that
    // language's rules. English collation sorts Chinese names by code point,
    // which is not the order a Chinese reader expects to find them in.
    return [...names.values()].sort((a, b) => a.localeCompare(b, reportLocale(lang)));
};

/**
 * Where a table ended on the page.
 *
 * AutoTable reports the position of its last row through the document's
 * `lastAutoTable`, and the report's own layout continues from there. The
 * plugin's own types say that position is optional, and the table object is
 * not there at all until a table has been drawn, so the position is checked
 * rather than assumed. A table that did not come out is refused: carrying on
 * from a guessed position would draw the next section on top of the table.
 */
const tableEnd = (doc: jsPDF): number => {
    const table = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable;
    const finalY = table?.finalY;
    if (typeof finalY !== 'number' || !Number.isFinite(finalY)) {
        throw new Error('A table in the report did not finish drawing.');
    }
    return finalY;
};

/** One line of the "what this report holds" list. */
interface MetaLine {
    label: string;
    value?: string;
}

/**
 * The document, drawn.
 *
 * Everything the reader needs to know about the report is on the first page:
 * which days it covers, what it includes, and how many records it holds. The
 * tables and the curves follow.
 */
export const buildReportDocument = async (
    report: PreparedReport,
    lang: Lang,
    t: T,
    generatedAt: Date = new Date(),
): Promise<jsPDF> => {
    const font = await loadReportFont(lang);
    resetReportDateFormatters();
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
    doc.addFileToVFS(font.file, font.base64);
    doc.addFont(font.file, font.name, 'normal');
    doc.setFont(font.name, 'normal');

    const left = PAGE.marginLeft;
    const width = PAGE.contentWidth;
    let y: number = PAGE.marginTop;

    const space = (needed: number): void => {
        if (y + needed <= PAGE.height - PAGE.marginBottom) return;
        doc.addPage();
        y = PAGE.marginTop;
    };

    // The title block: a dark title and a muted date on white, under the slim
    // accent rule that every page carries. A filled band this size would put
    // a sheet of colour on every printed report.
    drawText(doc, t('export.pdf.title'), left, 13, { size: TYPE.title, color: COLORS.ink, bold: true });
    const generated = t('export.pdf.generated_on');
    const gap = generated.endsWith(':') ? ' ' : '';
    drawText(doc, generated + gap + formatDay(lang, generatedAt), left, 19.5, {
        size: TYPE.small,
        color: COLORS.muted,
    });
    y = 26;

    const headingHeight = 11.5;
    const heading = (text: string, minimumHeight: number): void => {
        space(minimumHeight);
        drawText(doc, text, left, y + 4, { size: TYPE.section, color: COLORS.purple, bold: true });
        drawLine(doc, left, y + 7.5, left + width, y + 7.5, COLORS.purpleLine, 0.4);
        y += headingHeight;
    };

    const paragraph = (text: string, size: number = TYPE.body, color: Rgb = COLORS.ink): void => {
        const height = paragraphHeight(doc, text, size, width, 1.3);
        space(height + 3);
        drawParagraph(doc, text, left, y + 3, { size, color, maxWidth: width, lineHeight: 1.3 });
        y += height + 3;
    };

    if (report.invalidRange) {
        paragraph(t('report.invalid_range'), TYPE.body, COLORS.purple);
    } else {
        // Each graph is named after the hormone it is about, the way the chart
        // itself names it.
        const graphs = report.charts.map(
            chart =>
                hormoneLabel(chart.hormone, t) +
                ' (' +
                (chart.kind === 'measured' ? t('report.measured') : t('report.estimated')) +
                ')',
        );
        // Only what the report actually holds: a selection can name a hormone
        // the report has no rows for, and a report is not a selection. An
        // estimate is not a measurement, so it does not fill this line.
        const represented = new Set(report.labResults.map(lab => labHormone(lab)));
        const hormones = HORMONE_ORDER.filter(hormone => represented.has(hormone)).map(hormone =>
            hormoneLabel(hormone, t),
        );
        const medications = medicationNames(report, lang, t);
        const lines: MetaLine[] = [{ label: t('report.range'), value: rangeLabel(report, lang, t) }];
        if (report.selection.bothModes) lines.push({ label: t('report.scope') });
        lines.push({
            label: t('report.hormones'),
            value: hormones.length ? listFormat(lang).format(hormones) : t('report.none'),
        });
        lines.push({
            label: t('report.medications'),
            value: medications.length ? listFormat(lang).format(medications) : t('report.none'),
        });
        lines.push({
            label: t('report.graphs'),
            value: graphs.length ? listFormat(lang).format([...new Set(graphs)]) : t('report.none'),
        });

        for (const line of lines) {
            const label = line.value ? line.label + ' · ' + line.value : line.label;
            const height = paragraphHeight(doc, label, TYPE.body, width);
            space(height + 2);
            drawParagraph(doc, label, left, y + 3, {
                size: TYPE.body,
                color: COLORS.ink,
                maxWidth: width,
            });
            y += height + 2;
        }
        space(6);
        drawText(
            doc,
            fill(t('report.counts'), { doses: report.events.length, labs: report.labResults.length }),
            left,
            y + 3,
            { size: TYPE.small, color: COLORS.muted, maxWidth: width },
        );
        y += 9;

        // The curves, before the tables: they are what the report is for.
        if (report.charts.length) {
            const bounds = chartBounds(report.charts);
            for (const [index, chart] of report.charts.entries()) {
                const note = chart.kind === 'estimated' ? t('report.estimate_hint') : undefined;
                const height = chartHeight(doc, { note, width });
                if (index === 0) {
                    heading(t('report.graphs'), headingHeight + height);
                } else {
                    space(height);
                }
                drawChart(doc, chart, {
                    lang,
                    t,
                    x: left,
                    y,
                    width,
                    series: chart.kind === 'measured' ? t('report.measured') : t('report.estimated'),
                    note,
                    bounds,
                    domain: chart.domain,
                });
                y += height + 4;
            }
        }
        if (report.selection.measuredGraph && !report.charts.some(chart => chart.kind === 'measured')) {
            paragraph(t('report.measured_unavailable'), TYPE.small, COLORS.muted);
        }
        if (report.selection.estimatedGraph && !report.charts.some(chart => chart.kind === 'estimated')) {
            paragraph(t('report.estimate_unavailable'), TYPE.small, COLORS.muted);
        }

        // Keep a table heading, its columns and the first row together.
        const tableStartHeight = 30;
        if (report.labResults.length) {
            heading(t('export.pdf.labs'), tableStartHeight);
            const showAssay = report.labResults.some(lab => isLabAssay(lab.assay));
            const columns = [t('export.col.date'), t('export.col.item'), t('report.level'), t('export.col.unit')];
            if (showAssay) columns.push(t('lab.assay'));
            const rows = report.labResults.map(lab => [
                formatDayTime(lang, localDate(lab.timeH)),
                hormoneLabel(labHormone(lab), t),
                labValueLabel(lab, lang),
                labUnitLabel(lab),
                ...(showAssay ? [isLabAssay(lab.assay) ? t(`lab.assay.${lab.assay}`) : '—'] : []),
            ]);
            autoTable(doc, {
                startY: y,
                head: [columns],
                body: rows,
                margin: { left, right: PAGE.marginRight, top: PAGE.marginTop, bottom: PAGE.marginBottom },
                styles: {
                    font: REPORT_FONT_NAME,
                    fontStyle: 'normal',
                    fontSize: TYPE.body,
                    cellPadding: 1.8,
                    textColor: COLORS.ink,
                    lineColor: COLORS.grid,
                    lineWidth: 0.15,
                    overflow: 'linebreak',
                },
                headStyles: {
                    fillColor: COLORS.purple,
                    textColor: COLORS.white,
                    fontSize: TYPE.small,
                    cellPadding: 2,
                },
                alternateRowStyles: { fillColor: COLORS.lavender },
                showHead: 'everyPage',
                columnStyles: {
                    0: { cellWidth: 42 },
                    1: { cellWidth: 'auto' },
                    2: { cellWidth: 26, halign: 'right' },
                    3: { cellWidth: 20 },
                },
            });
            y = tableEnd(doc) + 6;
        }

        if (report.events.length) {
            heading(t('export.pdf.history'), tableStartHeight);
            const rows = report.events.map(event => [
                formatDayTime(lang, localDate(event.timeH)),
                medicationLabel(event, t),
                routeLabel(event, t),
                doseLabel(event, lang, t),
            ]);
            autoTable(doc, {
                startY: y,
                head: [[t('export.col.date'), t('report.medication'), t('report.route'), t('report.dose')]],
                body: rows,
                margin: { left, right: PAGE.marginRight, top: PAGE.marginTop, bottom: PAGE.marginBottom },
                styles: {
                    font: REPORT_FONT_NAME,
                    fontStyle: 'normal',
                    fontSize: TYPE.body,
                    cellPadding: 1.8,
                    textColor: COLORS.ink,
                    lineColor: COLORS.grid,
                    lineWidth: 0.15,
                    overflow: 'linebreak',
                },
                headStyles: {
                    fillColor: COLORS.purple,
                    textColor: COLORS.white,
                    fontSize: TYPE.small,
                    cellPadding: 2,
                },
                alternateRowStyles: { fillColor: COLORS.lavender },
                showHead: 'everyPage',
                columnStyles: {
                    0: { cellWidth: 42 },
                    1: { cellWidth: 'auto' },
                    2: { cellWidth: 38 },
                    3: { cellWidth: 26, halign: 'right' },
                },
            });
            // The history table is the last thing in the report, so nothing
            // reads where it ended; the check is still worth making, because a
            // table that did not come out is a report that cannot be vouched
            // for.
            tableEnd(doc);
        }

        if (!report.events.length && !report.labResults.length && !report.charts.length) {
            paragraph(t('report.empty'), TYPE.body, COLORS.muted);
        }
    }

    // The footer, once the number of pages is known.
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page += 1) {
        doc.setPage(page);
        drawRect(doc, 0, 0, PAGE.width, ACCENT_RULE, COLORS.purple);
        const lineY = PAGE.height - PAGE.marginBottom + 4;
        drawLine(doc, left, lineY, left + width, lineY, COLORS.purpleLine, 0.3);
        drawText(doc, t('export.pdf.title'), left, lineY + 4.5, { size: TYPE.tiny, color: COLORS.muted });
        drawText(doc, fill(t('report.page'), { page, total: pages }), left + width, lineY + 4.5, {
            size: TYPE.tiny,
            color: COLORS.muted,
            align: 'right',
        });
    }

    return doc;
};

/**
 * Write the report to a file.
 *
 * The bytes are handed to the platform's file port, which is the only thing
 * that knows where a file goes on the device: the desktop shell saves it, the
 * browser downloads it, the phone asks the system where to put it.
 */
export const saveReport = async (
    report: PreparedReport,
    lang: Lang,
    t: T,
    files: FileSavePort,
    generatedAt: Date = new Date(),
): Promise<FileSaveResult> => {
    const doc = await buildReportDocument(report, lang, t, generatedAt);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
    return files.save({
        name: fileName(generatedAt),
        mimeType: 'application/pdf',
        bytes,
    });
};
