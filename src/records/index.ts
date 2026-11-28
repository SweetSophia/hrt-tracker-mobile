import {
    normalizeCalibrationMethod,
    sanitizePKParams,
    type DoseEvent,
    type HRTMode,
    type LabResult,
} from '../domain/engine';
import {
    applySyncedStateToStorage,
    modeKeyFor,
    nsFor,
    readPlanFromStorage,
    type StorageLike,
} from '../utils/backupState';
import {
    inspectCompleteBackupBundle,
    mergeCompleteBackupBundleToStorage,
    replaceCompleteBackupBundleToStorage,
    type CompleteBackupActive,
} from '../utils/backupBundle';
import { MODE_KEYS, type SyncState } from '../utils/syncMerge';
import { planRecordOperation, type RecordContext } from './snapshot';
export { planRecordOperation } from './snapshot';
export type { RecordContext, RecordOperation, RecordPlan } from './snapshot';

function readModeList<T>(storage: StorageLike, owner: string, mode: HRTMode, suffix: string): T[] {
    const raw = storage.getItem(modeKeyFor(owner, mode, suffix));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Invalid stored record array');
    return parsed as T[];
}

/** A report needs only the confirmed dose and lab entries for the requested mode. */
export function readReportRecords(storage: StorageLike, owner: string, mode: HRTMode) {
    return {
        events: readModeList<DoseEvent>(storage, owner, mode, 'events'),
        labResults: readModeList<LabResult>(storage, owner, mode, 'lab-results'),
    };
}

export function activeFromSnapshot(storage: StorageLike, context: RecordContext): CompleteBackupActive {
    const { owner, mode } = context.scope;
    const weight = storage.getItem(nsFor(owner, 'weight'));
    const pk = storage.getItem(nsFor(owner, 'pk-params'));
    return {
        ...readReportRecords(storage, owner, mode),
        doseTemplates: readModeList(storage, owner, mode, 'dose-templates'),
        quickDoses: readModeList(storage, owner, mode, 'quick-doses'),
        supplies: readModeList(storage, owner, mode, 'supplies'),
        plan: readPlanFromStorage(storage, owner, mode) ?? [],
        weight: weight === null ? 70 : Number(weight),
        pkParams: pk === null ? null : sanitizePKParams(JSON.parse(pk)),
        calibrationMethod: normalizeCalibrationMethod(storage.getItem(nsFor(owner, 'cal-method'))),
        calibrationHistoryMode:
            storage.getItem(nsFor(owner, 'cal-history-mode')) === 'forward' ? 'forward' : 'retrospective',
    };
}
function checkClock(now: number) {
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid operation clock');
}

export function planCompleteBackup(context: RecordContext, raw: unknown, strategy: 'merge' | 'replace', now: number) {
    checkClock(now);
    if (strategy !== 'merge' && strategy !== 'replace') throw new Error('Invalid restore strategy');
    return planRecordOperation(context, storage => {
        const target = {
            storage,
            owner: context.scope.owner,
            mode: context.scope.mode,
            active: activeFromSnapshot(storage, context),
            now,
        };
        const preview = inspectCompleteBackupBundle(raw, target);
        const applied =
            strategy === 'replace'
                ? replaceCompleteBackupBundleToStorage(raw, target)
                : mergeCompleteBackupBundleToStorage(raw, target);
        // Upstream returns these for React setters; the async path must commit
        // them with records, before any successful state becomes visible.
        for (const [key, value] of Object.entries(applied.preferences)) storage.setItem(key, String(value));
        return { preview, applied };
    });
}

/** Input is the normalized sync state, not untrusted backup JSON. */
export function planSyncedState(context: RecordContext, state: SyncState, now: number) {
    checkClock(now);
    // Legacy sanitizers generate IDs/dates for incomplete import records. This
    // seam requires those fields to be assigned during normalization instead,
    // keeping planning repeatable and leaving legacy import behavior untouched.
    for (const mode of MODE_KEYS) {
        const block = state.modes[mode];
        for (const records of [block.events, block.labResults, block.doseTemplates]) {
            if (!Array.isArray(records) || records.some(record => !record || typeof record.id !== 'string')) {
                throw new Error('Expected normalized sync records');
            }
        }
        if (block.doseTemplates.some(record => !Number.isFinite(record.createdAt)))
            throw new Error('Expected normalized template dates');
    }
    return planRecordOperation(context, storage =>
        applySyncedStateToStorage(storage, context.scope.owner, context.scope.mode, state, now),
    );
}
