import type { jsPDF } from 'jspdf';
import type { Lang } from '../../i18n/languages';
import type { ReportChart } from '../types';
import {
    formatDay,
    formatDayShort,
    formatDayTime,
    formatPointValue,
    formatTickNumber,
    formatTime,
    hormoneLabel,
    localDate,
    type T,
} from '../labels';
import { COLORS, TYPE } from './theme';
import { drawDot, drawLine, drawParagraph, drawPolyline, drawText, paragraphHeight, textWidth } from './draw';

export interface ChartOptions {
    lang: Lang;
    t: T;
    /** The left edge of the chart. */
    x: number;
    /** The top edge of the chart. */
    y: number;
    /** How wide the chart may be. */
    width: number;
    /** What the series is: "Measured lab results" or "Estimated hormone level". */
    series: string;
    /** A line under the chart, such as the estimate's full-history hint. */
    note?: string;
    /**
     * The window every chart on the page shares, so that the same place on
     * two axes is the same day. Without it, each chart runs from its own first
     * point to its own last, and two curves cannot be read against each other.
     */
    bounds?: { fromH: number; toH: number };
    /**
     * The value range every chart of the same hormone and unit shares, so
     * that two plots can be read against each other.
     */
    domain?: [number, number];
}

const TITLE_HEIGHT = 9;
const PLOT_HEIGHT = 46;
const AXIS_HEIGHT = 7;
const Y_AXIS_WIDTH = 24;

/**
 * The height a chart takes, so the caller can leave room for it.
 *
 * The note under an estimate is a sentence that wraps differently in every
 * language, so its height is measured rather than assumed.
 */
export const chartHeight = (doc: jsPDF, options: { note?: string; width: number }): number =>
    TITLE_HEIGHT +
    PLOT_HEIGHT +
    AXIS_HEIGHT +
    (options.note ? paragraphHeight(doc, options.note, TYPE.tiny, options.width, 1.25) + 2 : 0);

/** How many dates the axis names. A long range gets a handful, a short one more. */
const tickCount = (spanDays: number): number => Math.min(5, Math.max(2, Math.ceil(spanDays / 30)));

/**
 * A round step for an axis.
 *
 * The same choice the app's own charts make (src/components/ResultChart.tsx),
 * so a report's axis reads like the screen it came from: the numbers on it
 * are 20, 40, 60 rather than 27, 53, 80.
 */
const niceStep = (raw: number): number => {
    if (!(raw > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return nice * magnitude;
};

/**
 * A padded, tick-friendly [min, max] range around a few gridlines. The
 * bounds need not land on a measured value: an axis is a ruler, not a record.
 *
 * Null when no finite range can describe the values: a level imported as
 * 1e308, or two concentrations a floating-point increment apart, would make
 * every step overflow. Such a chart is left out rather than drawn wrong.
 */
export const buildDomain = (min: number, max: number, steps = 4): [number, number] | null => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max < min) return null;
    if (max === min) {
        // A single value still needs an axis around it. The room grows away
        // from zero, so a value below zero grows downwards and a value above
        // zero grows upwards.
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
    // A quantity that never went below zero does not get a negative axis. One
    // that did keeps its negative values inside its own range, or they would
    // be drawn below the axis and off the page.
    const low = min < 0 ? floorValue : Math.max(0, floorValue);
    if (high <= low) high = low + step;
    if (!Number.isFinite(high)) return null;
    return [low, high];
};

/** The most gridlines an axis may carry. */
const MAX_TICKS = 12;

/**
 * The values the axis names.
 *
 * Counted by index rather than by adding a step to the last value: with two
 * concentrations a floating-point increment apart, or a level near the
 * largest number a double can hold, adding a step can stop advancing and
 * the loop never ends.
 */
const ticksFor = ([low, high]: [number, number], steps = 4): number[] => {
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return [low];
    const step = niceStep((high - low) / steps);
    if (!Number.isFinite(step) || step <= 0) return [low];
    const count = Math.min(MAX_TICKS, Math.max(1, Math.ceil((high - low) / step)));
    const out: number[] = [];
    const start = Math.ceil(low / step - 1e-9) * step;
    for (let index = 0; index <= count; index += 1) {
        const value = start + index * step;
        if (!Number.isFinite(value) || value > high) break;
        out.push(Math.round(value / step) * step);
    }
    return out;
};

/**
 * One hormone's curve, drawn as vectors.
 *
 * The measured results are points, because that is what a lab result is: a
 * number on a day. The estimate is a line, because that is what a model
 * produces: a value between the doses that made it. Drawing them the same
 * way would say they are the same kind of thing.
 */
export const drawChart = (doc: jsPDF, chart: ReportChart, options: ChartOptions): number => {
    const { lang, t, x, y, width } = options;
    const points = chart.points.filter(point => Number.isFinite(point.timeH) && Number.isFinite(point.value));
    if (!points.length) return 0;

    const color = chart.kind === 'measured' ? COLORS.measured : COLORS.estimated;
    const plotLeft = x + Y_AXIS_WIDTH;
    const plotRight = x + width;
    const plotTop = y + TITLE_HEIGHT;
    const plotBottom = plotTop + PLOT_HEIGHT;

    const first = points[0];
    const last = points[points.length - 1];
    const minTime = options.bounds?.fromH ?? first.timeH;
    const maxTime = options.bounds?.toH ?? last.timeH;
    const spanHours = Math.max(0, maxTime - minTime);
    const spanDays = spanHours / 24;
    const single = spanHours === 0;

    const values = points.map(point => point.value);
    const domain = options.domain ?? buildDomain(Math.min(...values), Math.max(...values));
    // A chart whose values no finite range can describe is left out.
    if (!domain) return 0;
    const [lowValue, highValue] = domain;
    const valueSpan = Math.max(1e-9, highValue - lowValue);

    const toX = (timeH: number): number =>
        single ? (plotLeft + plotRight) / 2 : plotLeft + ((timeH - minTime) / spanHours) * (plotRight - plotLeft);
    const toY = (value: number): number => plotBottom - ((value - lowValue) / valueSpan) * PLOT_HEIGHT;

    // The title: which hormone, and which kind of number it is.
    const hormone = hormoneLabel(chart.hormone, t);
    drawText(doc, hormone, x, y + 4, { size: TYPE.section, color: COLORS.purple, bold: true });
    const hormoneWidth = textWidth(doc, hormone, TYPE.section);
    drawText(doc, options.series, x + hormoneWidth + 3, y + 4, { size: TYPE.small, color: COLORS.muted });

    // The unit, above the value axis: the numbers mean nothing without it.
    drawText(doc, chart.unit, plotLeft, plotTop - 1.5, { size: TYPE.tiny, color: COLORS.muted });

    // The grid and its labels.
    const valueTicks = ticksFor(domain);
    for (const value of valueTicks) {
        const lineY = toY(value);
        drawLine(doc, plotLeft, lineY, plotRight, lineY, COLORS.grid, value === lowValue ? 0.3 : 0.15);
        drawText(doc, formatTickNumber(lang, value), plotLeft - 2, lineY + 1.2, {
            size: TYPE.tiny,
            color: COLORS.muted,
            align: 'right',
        });
    }

    // The dates along the bottom. A chart that covers less than a day names the
    // hours instead, because two points a few hours apart are the same date.
    const ticks = single ? 1 : tickCount(spanDays);
    const crossYear = localDate(minTime).getFullYear() !== localDate(maxTime).getFullYear();
    for (let tick = 0; tick < ticks; tick += 1) {
        const ratio = ticks === 1 ? 0.5 : tick / (ticks - 1);
        const timeH = minTime + spanHours * ratio;
        const tickX = toX(timeH);
        const date = localDate(timeH);
        const edge = tick === 0 || tick === ticks - 1;
        const label = single
            ? formatDayTime(lang, date)
            : spanHours < 24
              ? formatTime(lang, date)
              : spanHours < 48
                ? formatDayTime(lang, date)
                : edge && crossYear
                  ? formatDay(lang, date)
                  : formatDayShort(lang, date);
        drawText(doc, label, tickX, plotBottom + 4, {
            size: TYPE.tiny,
            color: COLORS.muted,
            align: tick === 0 ? 'left' : tick === ticks - 1 ? 'right' : 'center',
        });
        if (!single) {
            drawLine(doc, tickX, plotBottom, tickX, plotBottom + 1.5, COLORS.grid, 0.2);
        }
    }
    drawLine(doc, plotLeft, plotTop, plotLeft, plotBottom, COLORS.grid, 0.3);

    // The series itself. A measured result is a point on a day, not a curve
    // between two days: joining the dots with a line would claim there was a
    // measurement in between, and there was not.
    if (chart.kind === 'measured') {
        for (const point of points) {
            drawDot(doc, toX(point.timeH), toY(point.value), 1.1, color);
        }
    } else {
        drawPolyline(
            doc,
            points.map(point => ({ x: toX(point.timeH), y: toY(point.value) })),
            color,
            0.5,
            [1.2, 1],
        );
    }

    // A few points can carry their own value; a dense curve cannot, and the
    // axis speaks for it. The label is kept inside the plot, so a point at the
    // edge does not print its number over the value axis.
    if (points.length <= 6) {
        let lastRight = Number.NEGATIVE_INFINITY;
        for (const point of points) {
            const pointX = toX(point.timeH);
            const label = formatPointValue(lang, point.value);
            const half = textWidth(doc, label, TYPE.tiny) / 2;
            const labelX = Math.min(Math.max(pointX, plotLeft + half), plotRight - half);
            if (labelX - half < lastRight + 1.5) continue;
            lastRight = labelX + half;
            const labelY = toY(point.value) - 2;
            drawText(doc, label, labelX, labelY < plotTop + 2 ? toY(point.value) + 4 : labelY, {
                size: TYPE.tiny,
                color: color,
                align: 'center',
            });
        }
    }

    if (options.note) {
        drawParagraph(doc, options.note, x, plotBottom + AXIS_HEIGHT + 4, {
            size: TYPE.tiny,
            color: COLORS.muted,
            maxWidth: width,
            lineHeight: 1.25,
        });
    }

    return chartHeight(doc, { note: options.note, width });
};
