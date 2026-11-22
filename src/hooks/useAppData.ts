import { useState, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ShowDialog } from '../contexts/DialogContext';
import {
    DoseEvent,
    interpolateConcentration_E2,
    interpolateConcentration_CPA,
    interpolateConcentration_T,
    LabResult,
    CalibrationMethod,
    CalibrationHistoryMode,
    PKCustomParams,
    applyPKOverrides,
} from '../domain/engine';
import { createDayLabelFormatter, toDayKey } from '../utils/helpers';
import { detectRegimens, Supply } from '../utils/regimen';
import { PlanItem, regimensFromPlan } from '../utils/plan';
import { DoseTemplate, ModelSettings, QuickDose } from '../utils/backupState';
import {
    buildCompleteBackupBundleReportFromStorage,
    inspectCompleteBackupBundle,
    type CompleteBackupMergeResult,
    type CompleteBackupReplaceResult,
} from '../utils/backupBundle';
import { useAppModel } from './useAppModel';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import { useRecordController } from '../contexts/RecordsContext';
import { SyncState, fingerprintState, normalizeSyncState } from '../utils/syncMerge';
import {
    planCompleteBackup,
    planSyncedState,
    planRecordOperation,
    type RecordContext,
    type RecordOperation,
} from '../records';
import {
    exportRecordState,
    planEdit,
    planPatchReplacement,
    planLegacyImport,
    prepareLegacyImport,
    readRecordState,
    reviewBinding,
    assertReview,
    type RecordEdit,
} from '../records/commands';

export type { DoseTemplate, QuickDose } from '../utils/backupState';
export interface DoseDayGroup {
    key: string;
    label: string;
    events: DoseEvent[];
}

/** React reads confirmed snapshots; all writes are admitted through the controller. */
export const useAppData = (showDialog: ShowDialog, { withPrediction = false }: { withPrediction?: boolean } = {}) => {
    const { t, lang } = useTranslation();
    const { mode, isTransmasc } = useHRTMode();
    const { controller, state } = useRecordController();
    if (state.status !== 'ready') throw new Error('Record boundary is not ready');
    const identity = state.scope;
    const scope = `${identity.owner}|${identity.mode}`;
    // RecordBoundary already gates hydration; keep the old sync fields as aliases.
    const readyScope = scope;
    const liveContext = (): RecordContext => {
        const current = controller.getState();
        if (current.status !== 'ready' || current.scope !== identity) throw new Error('Record scope changed');
        return current;
    };
    const active = useMemo(
        () => readRecordState({ scope: identity, snapshots: state.snapshots }),
        [identity, state.snapshots],
    );
    const {
        events,
        weight,
        birthYear,
        ageBeta,
        labResults,
        calibrationMethod,
        calibrationHistoryMode,
        doseTemplates,
        quickDoses,
        supplies,
        pkParams,
        plan,
    } = active;
    const modelBirthYear = ageBeta ? birthYear : null;
    // Web Forecast and deferred demo consumers still use the UI engine's local overrides.
    // The mobile shared model installs its own captured parameters inside its worker.
    applyPKOverrides(pkParams);
    const [currentTime, setCurrentTime] = useState(new Date());
    const dispatch = <T>(operation: RecordOperation<T>) => {
        liveContext(); // A retained UI callback cannot redirect a write to a new account/mode.
        return controller.dispatch(operation);
    };
    const edit = async (input: RecordEdit): Promise<boolean> => {
        const command = structuredClone(input);
        const now = Date.now();
        try {
            return (await dispatch(context => planEdit(context, command, now))).active;
        } catch {
            return false;
        } // Controller publishes a visible, retryable storage error.
    };
    const setWeight = (value: number) => edit({ kind: 'scalar', key: 'weight', value });
    const setBirthYear = (value: number | null) => edit({ kind: 'scalar', key: 'birth-year', value });
    const setAgeBeta = (value: boolean) => edit({ kind: 'scalar', key: 'age-beta', value });
    const setCalibrationMethod = (value: CalibrationMethod) => edit({ kind: 'scalar', key: 'cal-method', value });
    const setCalibrationHistoryMode = (value: CalibrationHistoryMode) =>
        edit({ kind: 'scalar', key: 'cal-history-mode', value });
    const setPkParams = (value: PKCustomParams) => edit({ kind: 'scalar', key: 'pk-params', value });
    const clearPkParams = () => edit({ kind: 'scalar', key: 'pk-params', value: null });
    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);
    // The clock only ticks once a minute, so a dose logged "now" is later than
    // it and reads as scheduled for the future until the next tick. Catch the
    // clock up whenever the log changes.
    useEffect(() => {
        setCurrentTime(new Date());
    }, [events]);

    const regimens = useMemo(() => {
        const nowH = currentTime.getTime() / 3600000;
        return plan.length ? regimensFromPlan(plan, events, nowH) : detectRegimens(events, nowH);
    }, [plan, events, currentTime]);
    const { simulation, simulationAhead, calibration, modelStatus, retryModel, modelNowMs, runForecast, runDemo } =
        useAppModel({
            scope: identity,
            events,
            weightKG: weight,
            birthYear: modelBirthYear,
            labs: labResults,
            pkParams,
            calibrationMethod,
            historyMode: calibrationHistoryMode,
            regimens,
            withPrediction,
            nowMs: currentTime.getTime(),
        });

    const calibrationFn = calibration.factorFn;

    const currentLevel = useMemo(() => {
        if (!simulation) return 0;
        const h = currentTime.getTime() / 3600000;
        const baseE2 = interpolateConcentration_E2(simulation, h) || 0;
        return baseE2 * calibrationFn(h);
    }, [simulation, currentTime, calibrationFn]);

    // Cyproterone (ng/mL) at the current time. Uncalibrated: labs measure E2 only.
    const currentCPA = useMemo(() => {
        if (!simulation) return 0;
        const h = currentTime.getTime() / 3600000;
        return interpolateConcentration_CPA(simulation, h) || 0;
    }, [simulation, currentTime]);

    // Total testosterone (ng/dL) at the current time — only meaningful in transmasc mode.
    const currentT = useMemo(() => {
        if (!simulation) return 0;
        const h = currentTime.getTime() / 3600000;
        return interpolateConcentration_T(simulation, h) || 0;
    }, [simulation, currentTime]);

    // One section per local calendar day, newest first.
    //
    // #69: this used to accumulate into an object keyed by the day's *display*
    // label, which carries no year, so a dose on 2025-08-27 and one on 2026-08-27
    // hashed to the same bucket and rendered under a single "8月27日" heading.
    // Key and heading are two separate values now.
    //
    // An array rather than a Record, because `sorted` is already newest-first and
    // run-length grouping keeps that order structurally. Object key enumeration
    // would not: it quietly re-sorts any key that looks like an array index, so a
    // key such as "20260827" would have come back oldest-first.
    const groupedEvents = useMemo<DoseDayGroup[]>(() => {
        const formatLabel = createDayLabelFormatter(lang);
        const sorted = [...events].sort((a, b) => b.timeH - a.timeH);
        const groups: DoseDayGroup[] = [];
        for (const e of sorted) {
            const at = new Date(e.timeH * 3600000);
            const key = toDayKey(at);
            const last = groups[groups.length - 1];
            if (last && last.key === key) last.events.push(e);
            else groups.push({ key, label: formatLabel(at), events: [e] });
        }
        return groups;
    }, [events, lang]);

    const currentStatus = useMemo(() => {
        if (isTransmasc) {
            // Transmasc: total T status bands (ng/dL). Reference: male range 300–1000 ng/dL.
            if (currentT > 0) {
                const c = currentT;
                if (c > 1000)
                    return {
                        label: 'status.level.t_high',
                        color: 'text-[var(--warning)]',
                        bg: 'bg-[var(--surface-muted)]',
                        border: 'border-[var(--border)]',
                    };
                if (c >= 600)
                    return {
                        label: 'status.level.t_upper',
                        color: 'text-[var(--status-positive)]',
                        bg: 'bg-[var(--surface-muted)]',
                        border: 'border-[var(--border)]',
                    };
                if (c >= 300)
                    return {
                        label: 'status.level.t_male',
                        color: 'text-[var(--status-positive)]',
                        bg: 'bg-[var(--surface-muted)]',
                        border: 'border-[var(--border)]',
                    };
                if (c >= 100)
                    return {
                        label: 'status.level.t_subtarget',
                        color: 'text-[var(--status-violet)]',
                        bg: 'bg-[var(--surface-muted)]',
                        border: 'border-[var(--border)]',
                    };
                return {
                    label: 'status.level.t_low',
                    color: 'text-[var(--status-neutral)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            }
            return null;
        }
        if (currentLevel > 0) {
            const conc = currentLevel;
            if (conc > 300)
                return {
                    label: 'status.level.high',
                    color: 'text-[var(--warning)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            if (conc >= 100 && conc <= 200)
                return {
                    label: 'status.level.mtf',
                    color: 'text-[var(--status-positive)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            if (conc >= 70 && conc <= 300)
                return {
                    label: 'status.level.luteal',
                    color: 'text-[var(--status-info)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            if (conc >= 30 && conc < 70)
                return {
                    label: 'status.level.follicular',
                    color: 'text-[var(--status-violet)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            if (conc >= 8 && conc < 30)
                return {
                    label: 'status.level.male',
                    color: 'text-[var(--status-neutral)]',
                    bg: 'bg-[var(--surface-muted)]',
                    border: 'border-[var(--border)]',
                };
            return {
                label: 'status.level.low',
                color: 'text-[var(--warning)]',
                bg: 'bg-[var(--surface-muted)]',
                border: 'border-[var(--border)]',
            };
        }
        return null;
    }, [currentLevel, currentT, isTransmasc]);

    const addEvents = async (records: DoseEvent[], replacePreviousPatch = false): Promise<string[] | null> => {
        if (!replacePreviousPatch) {
            return (await edit({ kind: 'events', action: 'add', records })) ? records.map(record => record.id) : null;
        }
        const applications = structuredClone(records);
        const removalIds = applications.map(() => uuidv4());
        const now = Date.now();
        try {
            const { active, result } = await dispatch(context =>
                planPatchReplacement(context, applications, removalIds, now),
            );
            return active ? result : null;
        } catch {
            return null;
        }
    };
    const updateEvent = (event: DoseEvent) => edit({ kind: 'events', action: 'update', records: [event] });
    const deleteEvent = (id: string) => edit({ kind: 'events', action: 'delete', ids: [id] });
    const deleteEvents = (ids: string[]) => edit({ kind: 'events', action: 'delete', ids });
    const clearAllEvents = () => {
        const ids = readRecordState(liveContext()).events.map(event => event.id);
        if (ids.length)
            showDialog(
                'confirm',
                t('drawer.clear_confirm'),
                () => {
                    void deleteEvents(ids);
                },
                { danger: true, confirmLabel: t('btn.delete') },
            );
    };
    const addLabResult = (result: LabResult) => edit({ kind: 'labResults', action: 'add', records: [result] });
    const saveLabResults = (records: LabResult[]) => edit({ kind: 'labResults', action: 'upsert', records });
    const updateLabResult = (result: LabResult) => edit({ kind: 'labResults', action: 'update', records: [result] });
    const deleteLabResult = (id: string) => edit({ kind: 'labResults', action: 'delete', ids: [id] });
    const clearLabResults = () => {
        const ids = readRecordState(liveContext()).labResults.map(result => result.id);
        if (ids.length)
            showDialog(
                'confirm',
                t('lab.clear_confirm'),
                () => {
                    void edit({ kind: 'labResults', action: 'delete', ids });
                },
                { danger: true, confirmLabel: t('btn.delete') },
            );
    };
    const addTemplate = (template: DoseTemplate) => edit({ kind: 'doseTemplates', action: 'add', records: [template] });
    const deleteTemplate = (id: string) => edit({ kind: 'doseTemplates', action: 'delete', ids: [id] });
    const addQuickDose = (dose: QuickDose) => edit({ kind: 'quickDoses', action: 'add', records: [dose] });
    const deleteQuickDose = (id: string) => edit({ kind: 'quickDoses', action: 'delete', ids: [id] });
    const saveSupply = (supply: Supply) => edit({ kind: 'supplies', action: 'upsert', records: [supply] });
    const deleteSupply = (id: string) => edit({ kind: 'supplies', action: 'delete', ids: [id] });
    const savePlanItem = (item: PlanItem) => edit({ kind: 'plan', action: 'upsert', records: [item] });
    const deletePlanItem = (id: string) => edit({ kind: 'plan', action: 'delete', ids: [id] });

    // Each confirmation owns its immutable payload and exact snapshot binding.
    // Cancelling drops this closure; there is no shared pending review to consume.
    const prepareImportedData = (parsed: unknown): (() => Promise<boolean>) | null => {
        try {
            const context = liveContext();
            // Called by import event handlers, never during render.
            // eslint-disable-next-line react-hooks/purity
            const now = Date.now();
            const prepared = prepareLegacyImport(parsed, now, uuidv4);
            planLegacyImport(context, prepared, 'replace', now);
            const reviewed = reviewBinding(context);
            return () => importLegacy(prepared, 'replace', reviewed, now);
        } catch {
            return null;
        }
    };
    const importLegacy = async (
        raw: unknown,
        strategy: 'merge' | 'replace',
        reviewed?: string,
        now = Date.now(),
    ): Promise<boolean> => {
        try {
            const prepared = prepareLegacyImport(raw, now, uuidv4);
            const receipt = await dispatch(context => {
                if (reviewed) assertReview(context, reviewed);
                return planLegacyImport(context, prepared, strategy, now);
            });
            if (!receipt.active) return false;
            showDialog(
                'alert',
                strategy === 'replace'
                    ? t('drawer.import_success')
                    : t('account.merge_success').replace(
                          '{n}',
                          String('mergedCount' in receipt.result ? receipt.result.mergedCount : 0),
                      ),
            );
            return true;
        } catch {
            // A stale component must not display a completion over another scope.
            try {
                liveContext();
            } catch {
                return false;
            }
            showDialog('alert', t(strategy === 'replace' ? 'drawer.import_error' : 'account.merge_failed'));
            return false;
        }
    };
    const mergeImportedData = (raw: unknown) => importLegacy(raw, 'merge');
    const buildExportPayload = () => exportRecordState(liveContext());
    const buildCompleteBackupBundle = (createdAt?: string) => {
        const context = liveContext();
        return planRecordOperation(context, storage =>
            buildCompleteBackupBundleReportFromStorage(
                storage,
                context.scope.owner,
                context.scope.mode,
                readRecordState(context),
                createdAt,
            ),
        ).result;
    };
    const completeReview = useRef<string>();
    const previewCompleteBackupBundle = (raw: unknown) => {
        const context = liveContext();
        completeReview.current = reviewBinding(context);
        return planRecordOperation(context, storage =>
            inspectCompleteBackupBundle(raw, {
                storage,
                owner: context.scope.owner,
                mode,
                active: readRecordState(context),
            }),
        ).result;
    };
    const completeBackup = async (raw: unknown, strategy: 'merge' | 'replace') => {
        const reviewed = completeReview.current ?? reviewBinding(liveContext());
        const input = structuredClone(raw);
        const now = Date.now();
        const receipt = await dispatch(context => {
            assertReview(context, reviewed);
            return planCompleteBackup(context, input, strategy, now);
        });
        return receipt.active ? receipt.result.applied : null;
    };
    const applyCompleteBackupBundle = (raw: unknown) =>
        completeBackup(raw, 'merge') as Promise<CompleteBackupMergeResult | null>;
    const replaceCompleteBackupBundle = (raw: unknown) =>
        completeBackup(raw, 'replace') as Promise<CompleteBackupReplaceResult | null>;
    const applySyncedState = async (input: SyncState, expectedPayload: unknown): Promise<boolean> => {
        const now = Date.now();
        const prepared = prepareLegacyImport(input, now, uuidv4) as SyncState;
        const expected = fingerprintState(normalizeSyncState(expectedPayload));
        const receipt = await dispatch(context => {
            if (fingerprintState(normalizeSyncState(exportRecordState(context))) !== expected)
                throw new Error('Records changed during sync; retry sync.');
            return planSyncedState(context, prepared, now);
        });
        return receipt.active;
    };

    // A change of any of the three, for cloud sync to schedule a push on.
    const modelSettings = useMemo<ModelSettings>(
        () => ({ calibrationMethod, calibrationHistoryMode, ageBeta }),
        [calibrationMethod, calibrationHistoryMode, ageBeta],
    );

    return {
        events,
        weight,
        setWeight,
        birthYear,
        setBirthYear,
        modelBirthYear,
        labResults,
        doseTemplates,
        quickDoses,
        pkParams,
        setPkParams,
        clearPkParams,
        simulation,
        modelStatus,
        retryModel,
        runForecast,
        runDemo,
        modelNowMs,
        modelSnapshot: active,
        currentTime,
        calibrationFn,
        calibrationMethod,
        setCalibrationMethod,
        calibrationHistoryMode,
        setCalibrationHistoryMode,
        ageBeta,
        setAgeBeta,
        modelSettings,
        calibration,
        currentLevel,
        currentCPA,
        plan,
        savePlanItem,
        deletePlanItem,
        currentT,
        currentStatus,
        simulationAhead,
        groupedEvents,
        addEvents,
        updateEvent,
        deleteEvent,
        deleteEvents,
        clearAllEvents,
        addLabResult,
        saveLabResults,
        updateLabResult,
        deleteLabResult,
        clearLabResults,
        addTemplate,
        deleteTemplate,
        addQuickDose,
        deleteQuickDose,
        regimens,
        supplies,
        saveSupply,
        deleteSupply,
        prepareImportedData,
        mergeImportedData,
        buildExportPayload,
        buildCompleteBackupBundle,
        previewCompleteBackupBundle,
        applyCompleteBackupBundle,
        replaceCompleteBackupBundle,
        applySyncedState,
        // Compatibility fields: RecordBoundary ensures selected and confirmed
        // scopes agree before this hook and its cloud-sync caller can run.
        scope,
        readyScope,
    };
};
