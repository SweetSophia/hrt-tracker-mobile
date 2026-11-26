import { NativeBackScope, useNativeBackOwner } from '../hooks/useNativeBackOwner';
import { useMounted } from '../hooks/useMounted';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AddCancelLabel } from '../components/StableLabel';
import PageHeader, { PAGE_COLUMN, loggingHeaderAction, loggingHeaderActionAccent } from '../components/PageHeader';
import { Trash, Select, Repeat, ChevronDown } from '../components/icons';
import Tick from '../components/Tick';
import Switch from '../components/Switch';
import Doodle from '../components/Doodle';
import { v4 as uuidv4 } from 'uuid';
import { DoseEvent, Route, Ester, ExtraKey, getToE2Factor, isEstradiolEster, isTestosteroneEster } from '../../logic';
import { patchRemovalPairs } from '../domain/shared/patch';
import { LOCALE_MAP, formatTime, formatWearDays } from '../utils/helpers';
import { formatRecordDecimal, parseRecordDecimal } from '../utils/recordDecimal';
import { drugLabel } from '../utils/regimenText';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from '../contexts/LanguageContext';
import DoseForm from '../components/DoseForm';
import Stepper from '../components/Stepper';
import LogDoodle from '../components/LogDoodle';
import type { DoseTemplate } from '../components/DoseForm';
import { QuickDose } from '../components/dose_form/QuickDoseButtons';
import { DoseDayGroup } from '../hooks/useAppData';
import { inertWhen } from '../utils/inert';

const MAX_BATCH_COUNT = 365;

// Now, in the hours every dose's time is kept in, for a handler to read at
// the moment it runs.
const hoursNow = () => Date.now() / 3600000;

const muted = 'text-[var(--text-muted)]';
const on = 'text-[var(--text)]';
const headerBtn = `${loggingHeaderAction} hover:bg-[var(--surface-hover)]`;

// Keep the selection actions compact on narrow screens. Icon-only buttons
// keep their accessible names.
const iconOnNarrow = 'max-sm:w-11 max-sm:justify-center max-sm:px-0';
const labelOnWide = 'max-sm:hidden';

// The add form folds away over --duration-base. The saved row is looked for
// once it has, so it is scrolled to where it ends up, not to where it was
// while the form still sat above it.
const FOLD_MS = 240;
// How long a row just saved keeps its wash and tick.
const SAVED_MARK_MS = 1500;
// Long enough for the wash to fade back out (.row-wash) and the tick to be
// rubbed out before the tick is unmounted.
const SAVED_FADE_MS = 400;

const scrollBounds = (row: HTMLElement) => {
    const scroller = row.closest('.main-view');
    if (!scroller) return { top: 0, bottom: window.innerHeight };
    const viewport = scroller.getBoundingClientRect();
    const { scrollPaddingTop, scrollPaddingBottom } = getComputedStyle(scroller);
    return {
        top: viewport.top + (parseFloat(scrollPaddingTop) || 0),
        bottom: viewport.bottom - (parseFloat(scrollPaddingBottom) || 0),
    };
};

// Start tall rows below the sticky headings so their first line stays visible.
const revealRow = (row: HTMLElement) => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const { top, bottom } = scrollBounds(row);
    const block = row.getBoundingClientRect().height > bottom - top ? 'start' : 'center';
    row.scrollIntoView({ block, behavior: still ? 'auto' : 'smooth' });
};

// A day's label, held under the page header while its rows scroll by. It
// runs the column's full width: as wide as the rows' text only, it sat as a
// white box on an open row's wash, which showed past its ends. Once held, a
// short fade under it lets the rows passing beneath dissolve rather than be
// sliced through a line of text. A marker at the day's top says when it is
// held: gone above the label's own offset, the label has caught on the header.
const PinnedDayLabel: React.FC<{ children: React.ReactNode; headerHeight?: number }> = ({ children, headerHeight }) => {
    const [marker, setMarker] = useState<HTMLDivElement | null>(null);
    const [held, setHeld] = useState(false);
    useEffect(() => {
        const label = marker?.nextElementSibling;
        if (!marker || !label || typeof IntersectionObserver === 'undefined') return;
        const top = headerHeight ?? (parseFloat(getComputedStyle(label).top) || 0);
        const io = new IntersectionObserver(
            ([entry]) => setHeld(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)),
            { root: marker.closest('.main-view'), rootMargin: `-${top}px 0px 0px 0px` },
        );
        io.observe(marker);
        return () => io.disconnect();
    }, [marker, headerHeight]);
    return (
        <>
            <div ref={setMarker} aria-hidden="true" className="h-0" />
            <div
                data-held={held}
                className="sticky z-10 -mx-6 px-6 md:-mx-8 md:px-8 bg-[var(--bg)] pt-2 pb-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-[linear-gradient(var(--bg),transparent)] after:opacity-0 after:content-[''] data-[held=true]:after:opacity-100"
                style={{ top: 'var(--page-header-h, 5rem)' }}
            >
                {children}
            </div>
        </>
    );
};

// Whole days, but quarter days below one so a twice-daily or every-6-hours
// schedule can still be reached from the buttons.
const intervalStep = (v: number, dir: 1 | -1) => ((dir > 0 ? v >= 1 : v > 1) ? 1 : 0.25);

interface HistoryProps {
    t: (key: string) => string;
    isQuickAddOpen: boolean;
    setIsQuickAddOpen: (isOpen: boolean) => void;
    doseTemplates: DoseTemplate[];
    onUpdateEvent: (e: DoseEvent) => Promise<boolean>;
    onDeleteEvent: (id: string) => Promise<boolean>;
    onAddEvents: (events: DoseEvent[], replacePreviousPatch?: boolean) => Promise<boolean>;
    onDeleteEvents: (ids: string[]) => Promise<boolean>;
    onSaveTemplate: (t: DoseTemplate) => Promise<boolean>;
    onDeleteTemplate: (id: string) => Promise<boolean>;
    groupedEvents: DoseDayGroup[];
    /** Every dose, for the add form to start from what was taken last. */
    events?: DoseEvent[];
    /** The one-tap doses, shown at the top of the add form as they are in the edit sheet. */
    quickDoses?: QuickDose[];
    onAddQuickDose?: (dose: QuickDose) => Promise<boolean>;
    onDeleteQuickDose?: (id: string) => Promise<boolean>;
    /** A dose to open for editing on arrival, when another page (a dose on
     *  the Overview's chart) sent someone here to change it. */
    openEditId?: string | null;
    onOpenEditHandled?: () => void;
}

const History: React.FC<HistoryProps> = ({
    t,
    isQuickAddOpen,
    setIsQuickAddOpen,
    doseTemplates,
    onUpdateEvent,
    onDeleteEvent,
    onAddEvents,
    onDeleteEvents,
    onSaveTemplate,
    onDeleteTemplate,
    groupedEvents,
    events,
    quickDoses,
    onAddQuickDose,
    onDeleteQuickDose,
    openEditId,
    onOpenEditHandled,
}) => {
    const { showDialog } = useDialog();
    const { lang } = useTranslation();
    const locale = LOCALE_MAP[lang] ?? 'en-US';
    const isMounted = useMounted();
    const quickAddId = React.useId();
    const [headerHeight, setHeaderHeight] = useState<number>();
    const [editingId, setEditingId] = useState<string | null>(openEditId ?? null);

    // Batch add: repeat the quick-add dose at a fixed interval.
    const [batchOn, setBatchOn] = useState(false);
    const [batchIntervalDays, setBatchIntervalDays] = useState('1');
    const [batchCount, setBatchCount] = useState('7');

    // Batch delete: selection mode over the list.
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    useNativeBackOwner(() => {
        setSelectMode(false);
        setSelectedIds(new Set());
    }, selectMode);

    // Doses later than now fold into one section above the list, closed. A
    // batch add writes up to a year ahead, and newest first, those weeks that
    // had not happened yet pushed today's doses out of sight.
    const [plannedOpen, setPlannedOpen] = useState(false);

    // The row just added or edited. Once the form is out of the way it is
    // scrolled into view and marked for a moment, so a save shows where the
    // dose went instead of only changing the count, which invited logging it
    // twice. A new object on every save, so saving one row twice marks it twice.
    const [saved, setSaved] = useState<{ id: string } | null>(null);
    const [savedMarkOn, setSavedMarkOn] = useState(false);
    const savedRowRef = useRef<HTMLButtonElement | null>(null);
    // The row whose form is open, for focus to go back to when the form
    // closes. Closing it unmounts the control that had focus, which dropped
    // focus on the page itself, and a keyboard or screen reader that does
    // not keep its place started again from the top.
    const editingRowRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (!saved) return;
        const timers = [
            window.setTimeout(() => {
                const row = savedRowRef.current;
                if (row) revealRow(row);
                // Focus goes on to the row the save made, so the next Tab
                // starts from there. Only while the form's Save button has left
                // it nowhere: anything focused since is left where it is.
                const active = document.activeElement;
                if (!active || active === document.body) row?.focus({ preventScroll: true });
                setSavedMarkOn(true);
            }, FOLD_MS),
            window.setTimeout(() => setSavedMarkOn(false), FOLD_MS + SAVED_MARK_MS),
            window.setTimeout(() => setSaved(null), FOLD_MS + SAVED_MARK_MS + SAVED_FADE_MS),
        ];
        return () => timers.forEach(clearTimeout);
    }, [saved]);

    const allEvents = useMemo(() => groupedEvents.flatMap(g => g.events), [groupedEvents]);

    // Sent here to edit one dose: its form is already open (editingId starts
    // on it), and its row is brought into view, with the
    // planned section unfolded first if that's where it sits. The request is
    // taken in hand at once, not when the row is reached: leaving within the
    // fold left it standing, and the form opened again on the next visit. So
    // the timer stops only with the page, not when the request is cleared.
    const centerTimer = useRef(0);
    useEffect(() => {
        const timer = centerTimer;
        return () => window.clearTimeout(timer.current);
    }, []);
    useEffect(() => {
        if (!openEditId) return;
        setEditingId(openEditId);
        const ev = allEvents.find(e => e.id === openEditId);
        if (ev && ev.timeH > Date.now() / 3600000) setPlannedOpen(true);
        onOpenEditHandled?.();
        window.clearTimeout(centerTimer.current);
        centerTimer.current = window.setTimeout(() => {
            const row = document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(openEditId)}"]`);
            if (row) revealRow(row);
        }, FOLD_MS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openEditId]);
    const totalRecords = allEvents.length;
    const nowH = Date.now() / 3600000;

    // Each day split at now, so the planned part of today goes with the rest
    // of the planned doses and the part already taken stays in the list.
    const plannedDays: DoseDayGroup[] = [];
    const pastDays: DoseDayGroup[] = [];
    for (const day of groupedEvents) {
        const ahead = day.events.filter(e => e.timeH > nowH);
        if (ahead.length) plannedDays.push({ ...day, events: ahead });
        if (ahead.length < day.events.length) {
            pastDays.push(ahead.length ? { ...day, events: day.events.filter(e => e.timeH <= nowH) } : day);
        }
    }
    const plannedCount = plannedDays.reduce((n, day) => n + day.events.length, 0);

    const removedPatches = patchRemovalPairs(events ?? allEvents);

    const markSaved = (e: DoseEvent) => {
        // A dose saved for later lands in the planned section: open it, or
        // there would be no row to show. Measured against now, not the last
        // render's nowH: typing in the form does not re-render this page, so
        // that could be minutes old.
        if (e.timeH > hoursNow()) setPlannedOpen(true);
        setSavedMarkOn(false);
        setSaved({ id: e.id });
    };

    // Cancel hands focus back to the row. Cancel sits at the foot of a form
    // that can run past the screen. Bring the row into view if it sits
    // beneath the sticky headings or the bottom navigation.
    const closeEdit = () => {
        const row = editingRowRef.current;
        setEditingId(null);
        if (!row) return;
        row.focus({ preventScroll: true });
        const { top, bottom } = row.getBoundingClientRect();
        const visible = scrollBounds(row);
        if (top < visible.top || bottom > visible.bottom) revealRow(row);
    };

    // Batch add is a choice for one save, not a mode the form stays in: left
    // on, the next single dose quietly went in seven times. Every way the form
    // closes turns it off; the interval and count are kept for next time.
    const closeQuickAdd = () => {
        setIsQuickAddOpen(false);
        setBatchOn(false);
    };

    const parsedInterval = parseRecordDecimal(batchIntervalDays, locale);
    const parsedCount = parseRecordDecimal(batchCount, locale);
    const interval = parsedInterval.kind === 'number' ? parsedInterval.value : 0;
    const count = parsedCount.kind === 'number' ? Math.min(MAX_BATCH_COUNT, Math.floor(parsedCount.value)) : 0;
    const batchIsValid = interval > 0 && count >= 2;
    const decimalError = t('error.decimalFormat').replace('{example}', formatRecordDecimal(1.5, locale));
    const intervalError =
        parsedInterval.kind === 'invalid'
            ? decimalError
            : parsedInterval.kind === 'number' && interval <= 0
              ? t('error.nonPositive')
              : null;
    const countError =
        parsedCount.kind === 'invalid'
            ? decimalError
            : parsedCount.kind === 'number' && count < 2
              ? t('timeline.batch_count_min')
              : null;

    const handleQuickSave = async (e: DoseEvent, replacePreviousPatch = false) => {
        if (batchOn && !batchIsValid) return false;
        const list = [e];
        if (batchOn) {
            for (let k = 1; k < count; k++) {
                list.push({
                    ...e,
                    id: uuidv4(),
                    timeH: e.timeH + k * interval * 24,
                    extras: { ...e.extras },
                });
            }
        }
        if (!(await onAddEvents(list, replacePreviousPatch)) || !isMounted()) return false;
        closeQuickAdd();
        // For a batch, the first of the series: the dose at the time chosen.
        markSaved(e);
        return true;
    };

    const enterSelectMode = () => {
        setSelectMode(true);
        setSelectedIds(new Set());
        setEditingId(null);
        if (isQuickAddOpen) closeQuickAdd();
    };

    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedIds(new Set());
    };

    const toggleSelected = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        // All includes the planned doses: show them ticked rather than delete
        // rows that were folded away out of sight.
        if (selectedIds.size !== totalRecords) setPlannedOpen(true);
        setSelectedIds(prev => (prev.size === totalRecords ? new Set() : new Set(allEvents.map(e => e.id))));
    };

    // The question names the doses ticked when it was asked. Ticking more, or
    // fewer, while it's open takes it away, so Delete never removes a set
    // other than the one it named.
    const askDelete = useRef<(() => void) | null>(null);
    useEffect(() => {
        askDelete.current?.();
        askDelete.current = null;
    }, [selectedIds]);

    const handleDeleteSelected = () => {
        if (!selectedIds.size) return;
        const msg = t('timeline.batch_delete_confirm').replace('{n}', String(selectedIds.size));
        askDelete.current = showDialog(
            'confirm',
            msg,
            async () => {
                if (!(await onDeleteEvents([...selectedIds])) || !isMounted()) return;
                exitSelectMode();
            },
            { danger: true, title: t('timeline.batch_delete_title'), confirmLabel: t('btn.delete') },
        );
    };

    const batchHint = t('timeline.batch_hint')
        .replace('{d}', interval > 0 ? formatRecordDecimal(interval, locale) : '?')
        .replace('{n}', count >= 2 ? formatRecordDecimal(count, locale) : '?');

    const renderRow = (ev: DoseEvent) => {
        const isEditing = editingId === ev.id;
        const isSelected = selectedIds.has(ev.id);
        const isFuture = ev.timeH > nowH;
        const isSaved = saved?.id === ev.id;
        const isMarked = isSaved && savedMarkOn;
        const isRemoval = ev.route === Route.patchRemove;
        const applied = isRemoval ? removedPatches.get(ev) : undefined;
        const wornH = applied && ev.timeH - applied.timeH;
        const editOpen = isEditing && !selectMode;
        return (
            <div
                key={ev.id}
                data-event-id={ev.id}
                className="border-b-(length:--hairline) border-[var(--border)] last:border-b-0"
            >
                {/* A button, so a keyboard reaches every record: it opens the
                    record's form, or in select mode ticks it. The drawing at its
                    head says the route, which the first line alone does not when
                    gel, patch, tablet and pill all read "Estradiol (E2)". */}
                <button
                    type="button"
                    ref={el => {
                        if (isSaved) savedRowRef.current = el;
                        if (isEditing) editingRowRef.current = el;
                    }}
                    onClick={() => (selectMode ? toggleSelected(ev.id) : setEditingId(isEditing ? null : ev.id))}
                    {...(selectMode
                        ? { role: 'checkbox', 'aria-checked': isSelected }
                        : { 'aria-expanded': isEditing })}
                    className={`w-[calc(100%+1rem)] py-3.5 flex items-center gap-3 text-start cursor-pointer -mx-2 px-2 rounded-md ${isSaved ? 'row-wash' : ''} ${isMarked ? 'bg-[var(--accent-subtle)]' : `hover:bg-[var(--surface-hover)] ${isEditing || (selectMode && isSelected) ? 'bg-[var(--surface-hover)]' : ''}`}`}
                >
                    {selectMode ? (
                        <span
                            className={`check-dot inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full border ${isSelected ? 'bg-[var(--accent)] border-[var(--accent-ink)]' : 'border-[var(--border-strong)]'}`}
                        >
                            <Tick
                                on={isSelected}
                                size={11}
                                strokeWidth={2.5}
                                tone="current"
                                className="text-[var(--on-accent)]"
                            />
                        </span>
                    ) : null}
                    <Doodle name={ev.route} size={1.75} asleep={isFuture} />
                    <div className="flex-1 min-w-0">
                        {/* Let the time move down when a large label needs the full line. */}
                        <div className="flex flex-wrap items-center gap-x-2">
                            <div className="flex min-w-0 flex-auto flex-wrap items-baseline gap-x-2">
                                <span className="font-medium text-[var(--text)] [overflow-wrap:anywhere] text-sm">
                                    {isRemoval ? t('route.patchRemove') : drugLabel(ev.ester, t)}
                                </span>
                                {wornH !== undefined && (
                                    <span className={`text-xs [overflow-wrap:anywhere] ${muted}`}>
                                        {t('timeline.patch_worn').replace(
                                            '{d}',
                                            `${formatWearDays(wornH / 24)} ${t('unit.day_short')}`,
                                        )}
                                    </span>
                                )}
                            </div>
                            <span className="ms-auto inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-[var(--text-muted)]">
                                {isSaved && <Tick on={savedMarkOn} size={14} />}
                                {formatTime(new Date(ev.timeH * 3600000))}
                            </span>
                        </div>
                        {/* A removal is the one line: its route is its name,
                            and it has no amount of its own. */}
                        {!isRemoval && (
                            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums text-[var(--text-muted)]">
                                <span className="truncate">{t(`route.${ev.route}`)}</span>
                                {ev.extras[ExtraKey.releaseRateUGPerDay] ? (
                                    <>
                                        <span className="text-[var(--text)]">{`${ev.extras[ExtraKey.releaseRateUGPerDay]} µg/d`}</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-[var(--text)] font-medium">{`${ev.doseMG.toFixed(2)} mg`}</span>
                                        {ev.ester !== Ester.E2 && isEstradiolEster(ev.ester) && (
                                            <span className="opacity-70">
                                                {`(${t('label.e2')} eq: ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg)`}
                                            </span>
                                        )}
                                        {isTestosteroneEster(ev.ester) && ev.ester !== Ester.T && (
                                            <span className="opacity-70">
                                                {`(${t('label.t')} eq: ${(ev.doseMG * getToE2Factor(ev.ester)).toFixed(2)} mg)`}
                                            </span>
                                        )}
                                    </>
                                )}
                                {ev.route === Route.patchApply &&
                                    typeof ev.extras[ExtraKey.patchWearH] === 'number' &&
                                    ev.extras[ExtraKey.patchWearH]! > 0 && (
                                        <>
                                            <span className="text-[var(--text)]">{`${formatWearDays(ev.extras[ExtraKey.patchWearH]! / 24)} ${t('unit.day_short')}`}</span>
                                        </>
                                    )}
                            </div>
                        )}
                    </div>
                    {!selectMode && (
                        <ChevronDown size={16} className={`chev ${muted} shrink-0 ${isEditing ? 'rotate-180' : ''}`} />
                    )}
                </button>

                <div className="disclosure" data-open={editOpen} {...inertWhen(!editOpen)}>
                    <div className="disclosure-inner">
                        {/* Mounted only for the row being edited — with hundreds of
                            records, keeping every row's form mounted (even collapsed
                            to zero height) made every dose add/edit re-render all of
                            them at once. */}
                        {editOpen && (
                            <div className="pb-4 pt-1">
                                <DoseForm
                                    eventToEdit={ev}
                                    onSave={async e => {
                                        if (!(await onUpdateEvent(e)) || !isMounted()) return false;
                                        setEditingId(null);
                                        markSaved(e);
                                        return true;
                                    }}
                                    onCancel={closeEdit}
                                    onDelete={async id => {
                                        // The form calls onCancel after this, and the
                                        // row is going: nothing to hand focus back to.
                                        editingRowRef.current = null;
                                        if (!(await onDeleteEvent(id)) || !isMounted()) return false;
                                        setEditingId(null);
                                        return true;
                                    }}
                                    templates={doseTemplates}
                                    onSaveTemplate={onSaveTemplate}
                                    onDeleteTemplate={onDeleteTemplate}
                                    isInline={true}
                                    hideHeader={true}
                                    events={allEvents}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // `pinned` keeps the day's label under the header while its rows scroll
    // by. Not inside the planned section: that folds, and a fold clips.
    // A pinned label paints over the rows, so it stops 4px short of them and
    // the rows take the 4px up: the focus ring stands 4px off a row, and the
    // label's own padding hid the top of it on each day's first row.
    const renderDay = ({ key, label, events: dayEvents }: DoseDayGroup, pinned: boolean) => {
        const text = <span className="text-xs font-semibold text-[var(--text-muted)]">{label}</span>;
        return (
            <div key={key} className="mb-4 last:mb-0">
                {pinned ? (
                    <PinnedDayLabel headerHeight={headerHeight}>{text}</PinnedDayLabel>
                ) : (
                    <div className="bg-[var(--bg)] pt-2 pb-1">{text}</div>
                )}
                <div className="pt-1">{dayEvents.map(renderRow)}</div>
            </div>
        );
    };

    return (
        <div className="relative md:pb-32">
            <PageHeader
                reflow
                onHeightChange={setHeaderHeight}
                title={t('timeline.title')}
                subtitle={
                    selectMode
                        ? t('timeline.selected').replace('{n}', String(selectedIds.size))
                        : totalRecords === 1
                          ? t('timeline.records_one')
                          : t('timeline.records_n').replace('{n}', String(totalRecords))
                }
                actions={
                    selectMode ? (
                        <>
                            <button
                                type="button"
                                onClick={toggleSelectAll}
                                aria-label={t('timeline.select_all')}
                                className={`${headerBtn} ${muted} ${iconOnNarrow}`}
                            >
                                <Select size={15} strokeWidth={1.5} />
                                <span className={labelOnWide}>{t('timeline.select_all')}</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteSelected}
                                disabled={!selectedIds.size}
                                className={`${headerBtn} text-[var(--danger)] disabled:opacity-40`}
                            >
                                <Trash size={15} strokeWidth={1.5} className={labelOnWide} />
                                <span>
                                    {t('btn.delete')}
                                    {selectedIds.size ? ` (${selectedIds.size})` : ''}
                                </span>
                            </button>
                            <button type="button" onClick={exitSelectMode} className={`${headerBtn} ${muted}`}>
                                <span>{t('btn.cancel')}</span>
                            </button>
                        </>
                    ) : (
                        <>
                            {totalRecords > 0 && (
                                <button
                                    type="button"
                                    onClick={enterSelectMode}
                                    aria-label={t('timeline.select')}
                                    className={`${headerBtn} ${muted} ${iconOnNarrow}`}
                                >
                                    <Select size={15} strokeWidth={1.5} />
                                    <span className={labelOnWide}>{t('timeline.select')}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => (isQuickAddOpen ? closeQuickAdd() : setIsQuickAddOpen(true))}
                                aria-expanded={isQuickAddOpen}
                                aria-controls={quickAddId}
                                className={loggingHeaderActionAccent}
                            >
                                <AddCancelLabel
                                    wrap
                                    open={isQuickAddOpen}
                                    add={t('btn.add')}
                                    cancel={t('btn.cancel')}
                                />
                            </button>
                        </>
                    )
                }
            />

            {/* Said aloud when a save is marked, for anyone who cannot see the tick. */}
            <p className="sr-only" aria-live="polite">
                {savedMarkOn ? t('timeline.saved') : ''}
            </p>

            {/* Inert while closed, so a keyboard does not tab through a form it cannot see. */}
            <div id={quickAddId} className="disclosure mt-4" data-open={isQuickAddOpen} {...inertWhen(!isQuickAddOpen)}>
                <div className="disclosure-inner">
                    <div className={`${PAGE_COLUMN} mb-6`}>
                        <div className="flex items-center justify-between py-3">
                            <div>
                                <p className={`text-sm font-medium ${on}`}>{t('timeline.batch')}</p>
                                <p className={`text-xs ${muted} mt-0.5`}>{t('timeline.batch_desc')}</p>
                            </div>
                            <Switch checked={batchOn} onChange={setBatchOn} label={t('timeline.batch')} />
                        </div>
                        {batchOn && (
                            <div className="pb-4 pt-1 animate-[fade-in_var(--duration-base)_var(--ease-standard)] motion-reduce:animate-none">
                                <div className="grid grid-cols-2 gap-3">
                                    <Stepper
                                        label={t('timeline.batch_interval')}
                                        value={batchIntervalDays}
                                        onChange={setBatchIntervalDays}
                                        min={0.25}
                                        step={intervalStep}
                                        inputStep="0.25"
                                        decimalLocale={locale}
                                        error={intervalError}
                                    />
                                    <Stepper
                                        label={t('timeline.batch_count')}
                                        value={batchCount}
                                        onChange={setBatchCount}
                                        min={2}
                                        max={MAX_BATCH_COUNT}
                                        step={() => 1}
                                        inputStep="1"
                                        decimalLocale={locale}
                                        error={countError}
                                    />
                                </div>
                                <p className={`mt-3 flex items-start gap-2 text-xs ${muted}`}>
                                    <span className="icon-line">
                                        <Repeat size={14} />
                                    </span>
                                    <span>{batchHint}</span>
                                </p>
                            </div>
                        )}
                        <NativeBackScope active={isQuickAddOpen}>
                            <DoseForm
                                // Force remount on open so the default date resets to "now" (this row never unmounts, only collapses via CSS).
                                key={isQuickAddOpen ? 'open' : 'closed'}
                                eventToEdit={null}
                                onSave={handleQuickSave}
                                onCancel={closeQuickAdd}
                                onDelete={async () => false}
                                templates={doseTemplates}
                                onSaveTemplate={onSaveTemplate}
                                onDeleteTemplate={onDeleteTemplate}
                                saveBlockedReason={
                                    batchOn && !batchIsValid ? t('timeline.batch_check_fields') : undefined
                                }
                                isInline={true}
                                events={events ?? allEvents}
                                quickDoses={quickDoses}
                                onAddQuickDose={onAddQuickDose}
                                onDeleteQuickDose={onDeleteQuickDose}
                            />
                        </NativeBackScope>
                    </div>
                </div>
            </div>

            {/* The same empty state the Overview has, ending in the one thing
                to do here. Not while the form is open: it is already doing it. */}
            {groupedEvents.length === 0 && !isQuickAddOpen && (
                <div className={`${PAGE_COLUMN} flex flex-col items-center text-center py-16`}>
                    <LogDoodle className="w-24 h-auto mb-6" />
                    <p className={`text-sm font-semibold ${on} mb-1`}>{t('home.empty_title')}</p>
                    <p className={`text-sm ${muted} mb-6 max-w-xs text-balance`}>{t('home.empty_subtitle')}</p>
                    <button
                        type="button"
                        onClick={() => setIsQuickAddOpen(true)}
                        className="btn-primary h-auto min-h-9 max-w-full py-2 [overflow-wrap:anywhere] logging-touch-target"
                    >
                        {t('home.empty_cta')}
                    </button>
                </div>
            )}

            {plannedCount > 0 && (
                <div className={`${PAGE_COLUMN} mb-2`}>
                    {/* Ruled off from the list below, so open it still reads as
                        apart from the doses already taken. */}
                    <div className="border-b-(length:--hairline) border-[var(--border)]">
                        <button
                            type="button"
                            onClick={() => setPlannedOpen(o => !o)}
                            aria-expanded={plannedOpen}
                            className="w-full min-h-11 flex items-center gap-2 py-3 text-start"
                        >
                            <span className={`text-xs font-semibold ${muted}`}>{t('timeline.future')}</span>
                            <span className={`text-xs tabular-nums ${muted}`}>{plannedCount}</span>
                            <ChevronDown
                                size={16}
                                className={`chev ${muted} shrink-0 ms-auto ${plannedOpen ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {/* Widened by the rows' own bleed (8px) and the 4px their
                            focus ring stands off them, so the fold's clip neither
                            squares off their highlight nor cuts the ring's sides. */}
                        <div className="disclosure -mx-3" data-open={plannedOpen} {...inertWhen(!plannedOpen)}>
                            <div className="disclosure-inner">
                                <NativeBackScope active={plannedOpen}>
                                    <div className="px-3 pb-3">{plannedDays.map(day => renderDay(day, false))}</div>
                                </NativeBackScope>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {pastDays.length > 0 && <div className={PAGE_COLUMN}>{pastDays.map(day => renderDay(day, true))}</div>}
        </div>
    );
};

export default History;
