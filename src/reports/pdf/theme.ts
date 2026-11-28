/**
 * The report's own look: a deep purple on white, with a soft violet for the
 * rules and the row shading.
 *
 * The app's screens are warm and amber; a printed report is a different
 * object, read on paper, often in a clinic, and it carries its own palette
 * rather than the app's.
 */
export type Rgb = [number, number, number];

export const COLORS: Record<
    'ink' | 'muted' | 'purple' | 'purpleLine' | 'lavender' | 'white' | 'grid' | 'measured' | 'estimated',
    Rgb
> = {
    ink: [26, 25, 30],
    muted: [112, 106, 122],
    purple: [76, 29, 149],
    purpleLine: [196, 181, 253],
    lavender: [248, 246, 253],
    white: [255, 255, 255],
    grid: [226, 222, 240],
    measured: [91, 33, 182],
    estimated: [139, 92, 246],
};

/** A4 in millimetres, which is what jsPDF measures in. */
export const PAGE = {
    width: 210,
    height: 297,
    marginLeft: 16,
    marginRight: 16,
    marginTop: 14,
    marginBottom: 16,
    get contentWidth() {
        return PAGE.width - PAGE.marginLeft - PAGE.marginRight;
    },
} as const;

/** The slim accent rule across the top of every page. */
export const ACCENT_RULE = 1.8;

export const TYPE = {
    title: 19,
    section: 12,
    body: 9,
    small: 8,
    tiny: 7,
} as const;
