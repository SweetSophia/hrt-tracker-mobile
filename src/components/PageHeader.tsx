import React from 'react';
import { ArrowLeft } from './icons';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * The reading column every page sits in: one width, one side padding, centred
 * in whatever the sidebar leaves. Pinned to the left, a phone's width of rows
 * hugged the sidebar and left the rest of a desktop window empty.
 */
export const PAGE_COLUMN = 'mx-auto w-full max-w-2xl px-6 md:px-8';

/** A text button for the right side of a PageHeader (Select, Edit…): a capsule, its icon close to its words. */
export const headerAction =
    'inline-flex h-8 items-center gap-1 px-2.5 text-sm font-medium rounded-full hover:bg-[var(--surface-hover)]';

/** The same button for the action that does the page's job (Add, Log…): terracotta, with a tonal hover. */
export const headerActionAccent =
    'inline-flex h-8 items-center gap-1 px-2.5 text-sm font-medium rounded-full text-[var(--accent-ink)] hover:bg-[var(--accent-subtle)]';

/** A logging action with room for wrapped text and a 48px touch target. */
export const loggingHeaderAction =
    'logging-touch-target inline-flex min-h-8 max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium leading-snug [overflow-wrap:anywhere]';

export const loggingHeaderActionAccent = `${loggingHeaderAction} text-[var(--accent-ink)] hover:bg-[var(--accent-subtle)]`;

const on = 'text-[var(--text)]';
const muted = 'text-[var(--text-muted)]';

/**
 * The title bar at the top of every page: a large title on frosted glass that
 * sticks to the top of the scroller, so rows scrolling up blur away under it,
 * while its contents keep to PAGE_COLUMN and line up with the rows below. A
 * hairline appears under it only once something has scrolled beneath.
 *
 * A top-level page (Overview aside) has a plain title, an optional count
 * under it and optional actions on the right. A page reached from another one
 * gets `onBack`, and the title becomes the way back. A screen reader hears
 * the title and then "Back": the arrow alone said nothing, so the button was
 * announced as just the page's name. The visible title comes first, so
 * someone driving it by voice can still say what they see.
 *
 * `columnClassName` lets a page with a second rail (OpSec's contents) keep
 * the title aligned with the article while the body grows wider.
 */
const PageHeader: React.FC<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    onBack?: () => void;
    actions?: React.ReactNode;
    columnClassName?: string;
    reflow?: boolean;
    /** A stable listener for the sticky bar's rendered height. */
    onHeightChange?: (height: number) => void;
}> = ({ title, subtitle, onBack, actions, columnClassName = PAGE_COLUMN, reflow = false, onHeightChange }) => {
    const { t } = useTranslation();
    const barRef = React.useRef<HTMLDivElement>(null);
    // A zero-height marker just above the sticky bar: once it has scrolled out
    // of view, content is passing under the bar and the hairline shows.
    const [marker, setMarker] = React.useState<HTMLDivElement | null>(null);
    const [scrolled, setScrolled] = React.useState(false);
    React.useEffect(() => {
        if (!marker || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
        io.observe(marker);
        return () => io.disconnect();
    }, [marker]);

    React.useLayoutEffect(() => {
        const bar = barRef.current;
        if (!reflow || !bar) return;
        const scroller = bar.closest<HTMLElement>('.main-view');
        let measured = 0;
        const measure = () => {
            const height = bar.getBoundingClientRect().height;
            if (height <= 0 || measured === height) return;
            measured = height;
            scroller?.style.setProperty('--page-header-h', `${height}px`);
            onHeightChange?.(height);
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(bar, { box: 'border-box' });
        return () => {
            observer?.disconnect();
            scroller?.style.removeProperty('--page-header-h');
        };
    }, [reflow, onHeightChange]);

    const titleLayout = reflow ? 'leading-tight [overflow-wrap:anywhere]' : 'leading-8 truncate';
    return (
        <>
            <div ref={setMarker} aria-hidden="true" className="h-0" />
            <div
                ref={barRef}
                className={`glass glass-bar sticky top-0 z-20 transition-shadow ${scrolled ? 'shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border)]' : ''}`}
            >
                <div
                    className={`${columnClassName} pt-4 pb-3 flex items-end justify-between gap-x-4 ${reflow ? 'flex-wrap gap-y-2' : ''}`}
                >
                    <div className={`min-w-0 ${reflow ? 'max-w-full flex-auto' : 'flex-1'}`}>
                        {onBack ? (
                            <button
                                onClick={onBack}
                                className="flex min-w-0 max-w-full items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--surface-hover)]"
                            >
                                <ArrowLeft size={22} aria-hidden="true" className={`${muted} shrink-0`} />
                                <span
                                    className={`font-display text-[1.625rem] font-semibold tracking-[-0.02em] ${titleLayout} ${on}`}
                                >
                                    {title}
                                </span>
                                <span className="sr-only">, {t('nav.back')}</span>
                            </button>
                        ) : (
                            <h1 className={`text-[1.625rem] font-semibold tracking-[-0.02em] ${titleLayout} ${on}`}>
                                {title}
                            </h1>
                        )}
                        {subtitle && (
                            <p className={`text-xs ${muted} mt-0.5 ${reflow ? '[overflow-wrap:anywhere]' : ''}`}>
                                {subtitle}
                            </p>
                        )}
                    </div>
                    {actions && (
                        <div
                            className={`flex items-center shrink-0 ${reflow ? 'ms-auto max-w-full flex-wrap justify-end gap-2' : 'gap-1 -mr-2'}`}
                        >
                            {actions}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};

export default PageHeader;
