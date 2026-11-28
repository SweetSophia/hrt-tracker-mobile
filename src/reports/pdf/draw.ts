import type { jsPDF } from 'jspdf';
import { COLORS, type Rgb } from './theme';

export interface TextOptions {
    size?: number;
    color?: Rgb;
    /**
     * A heavier line: the font is stroked as well as filled, the way a title
     * reads. Only Latin and Cyrillic letters are stroked, because a stroke
     * that fattens a Latin stem fills the counters of a Chinese one.
     */
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    maxWidth?: number;
    lineHeight?: number;
}

/** A point in points is this many millimetres. */
const PT_TO_MM = 25.4 / 72;

/**
 * The scripts whose strokes are too fine for a fattening stroke.
 *
 * A Chinese or Japanese glyph is drawn with strokes about a fortieth of its
 * width, and the gaps between them are barely wider. Stroking the outline
 * fattens each stroke by the same amount and closes the gaps, so the glyph
 * comes out as a blot. Those scripts get their weight from size and colour
 * instead.
 */
const FINE_STROKED = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** The stroke width that reads as a bold Latin letter. */
const BOLD_STROKE = 0.014;

const strokeWeight = (text: string, size: number): number | null =>
    FINE_STROKED.test(text) ? null : size * BOLD_STROKE;

/**
 * The lines a block of text wraps into, at the size it will be drawn at.
 *
 * jsPDF measures with whatever font size the document happens to carry unless
 * it is told otherwise, so the size is passed to the splitter. Splitting at
 * the size the document happens to carry wraps the text for a different size
 * than the one it is drawn at: the block then takes more lines than the room
 * that was measured for it, and the block under it is covered.
 */
const wrappedLines = (doc: jsPDF, text: string, size: number, maxWidth: number): string[] =>
    doc.splitTextToSize(text, maxWidth, { fontSize: size });

/**
 * One line of text in the report's font.
 *
 * There is no bold cut of the font: the subset carries one weight, and a
 * heading gets its weight by being stroked as well as filled. That keeps the
 * embedded font half the size it would otherwise be.
 */
export const drawText = (doc: jsPDF, text: string, x: number, y: number, options: TextOptions = {}): void => {
    const size = options.size ?? 9;
    const color = options.color ?? COLORS.ink;
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    const stroke = options.bold ? strokeWeight(text, size) : null;
    if (stroke !== null) {
        doc.setDrawColor(color[0], color[1], color[2]);
        doc.setLineWidth(stroke);
    }
    doc.text(text, x, y, {
        align: options.align ?? 'left',
        maxWidth: options.maxWidth,
        lineHeightFactor: options.lineHeight,
        renderingMode: stroke !== null ? 'fillThenStroke' : 'fill',
    });
};

export interface ParagraphOptions extends TextOptions {
    /** How tall a line of the block is, as a multiple of the font size. */
    lineHeight?: number;
}

/**
 * A block of text that may wrap, and the room it takes.
 *
 * The height is measured rather than guessed: a line of medication names in
 * German or Japanese wraps where an English one does not, and a block that
 * overlaps the one under it is a block that hides a row.
 */
export const drawParagraph = (
    doc: jsPDF,
    text: string,
    x: number,
    y: number,
    options: ParagraphOptions = {},
): number => {
    const size = options.size ?? 9;
    const color = options.color ?? COLORS.ink;
    const lineHeight = options.lineHeight ?? 1.25;
    const maxWidth = options.maxWidth ?? Number.POSITIVE_INFINITY;
    const lines = wrappedLines(doc, text, size, maxWidth);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.setLineHeightFactor(lineHeight);
    const stroke = options.bold ? strokeWeight(text, size) : null;
    if (stroke !== null) {
        doc.setDrawColor(color[0], color[1], color[2]);
        doc.setLineWidth(stroke);
    }
    doc.text(lines, x, y, {
        align: options.align ?? 'left',
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        renderingMode: stroke !== null ? 'fillThenStroke' : 'fill',
    });
    doc.setLineHeightFactor(1.15);
    return lines.length * size * lineHeight * PT_TO_MM;
};

/** The room a block of text would take, without drawing it. */
export const paragraphHeight = (doc: jsPDF, text: string, size: number, maxWidth: number, lineHeight = 1.25): number =>
    wrappedLines(doc, text, size, maxWidth).length * size * lineHeight * PT_TO_MM;

/** A straight rule. */
export const drawLine = (
    doc: jsPDF,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: Rgb = COLORS.grid,
    width = 0.2,
    dash?: number[],
): void => {
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(width);
    doc.setLineDashPattern(dash ?? [], 0);
    doc.line(x1, y1, x2, y2);
    doc.setLineDashPattern([], 0);
};

/** A filled rectangle, for the header band and the row shading. */
export const drawRect = (doc: jsPDF, x: number, y: number, width: number, height: number, color: Rgb): void => {
    doc.setFillColor(color[0], color[1], color[2]);
    doc.rect(x, y, width, height, 'F');
};

/**
 * A whole line, drawn as one path.
 *
 * A curve of two hundred points is two hundred segments, and a segment per
 * call writes its own style commands into the file. One path writes them
 * once, and the dash pattern then runs along the whole curve instead of
 * restarting at every joint.
 */
export const drawPolyline = (
    doc: jsPDF,
    points: readonly { x: number; y: number }[],
    color: Rgb = COLORS.ink,
    width = 0.5,
    dash?: number[],
): void => {
    if (points.length < 2) return;
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(width);
    doc.setLineDashPattern(dash ?? [], 0);
    const first = points[0];
    // Each leg is the step from the point before it, which is how jsPDF's
    // path builder reads a list of lines.
    const relative = points.slice(1).map((point, index) => [point.x - points[index].x, point.y - points[index].y]);
    doc.lines(relative, first.x, first.y, [1, 1], 'S', false);
    doc.setLineDashPattern([], 0);
};

/** A circle, for a measured point on a chart. */
export const drawDot = (doc: jsPDF, x: number, y: number, radius: number, color: Rgb, filled = true): void => {
    doc.setFillColor(color[0], color[1], color[2]);
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(0.25);
    doc.circle(x, y, radius, filled ? 'FD' : 'S');
};

/** The width a string takes at a given size, in millimetres. */
export const textWidth = (doc: jsPDF, text: string, size: number): number => {
    doc.setFontSize(size);
    return doc.getTextWidth(text);
};
