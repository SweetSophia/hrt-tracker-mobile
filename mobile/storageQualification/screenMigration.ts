import type { ApplicationRuntime } from '../../src/application/runtime';
import type { RecordController } from '../../src/application/recordController';
import type { RecordStore } from '../../src/platform/contracts';
import { createNativeStores } from '../../src/platform/capacitor';
import { activeFromSnapshot, planCompleteBackup, planRecordOperation, type RecordContext } from '../../src/records';
import { buildCompleteBackupBundleReportFromStorage, type CompleteBackupBundle } from '../../src/utils/backupBundle';
import fixture from '../../tests/fixtures/mobile/backups/complete-v1.json';
import { canonical } from './backup';

export const SCREEN_NOW = Date.UTC(2026, 10, 1, 12);

/** Stable synthetic vectors: existing web format, with calibration disabled for UI qualification. */
export function screenFixtures() {
    const incoming: CompleteBackupBundle = JSON.parse(JSON.stringify(fixture), (key, value) => {
        if (key === 'timeH') return SCREEN_NOW / 3_600_000 - 12;
        // The frozen 2030 fixture also stores epoch milliseconds under tombstone IDs.
        if (typeof value === 'number' && value > 1_000_000_000_000) return SCREEN_NOW - 1000;
        return value;
    });
    incoming.createdAt = new Date(SCREEN_NOW).toISOString();
    incoming.calibration = { method: 'off', historyMode: 'forward' };
    incoming.preferences = { ...incoming.preferences, 'app-theme': 'light', 'hrt-lang': 'en' };
    const baseline = structuredClone(incoming);
    baseline.weight = 77;
    baseline.weightUpdatedAt = SCREEN_NOW - 2000;
    for (const mode of ['transfem', 'transmasc'] as const) {
        baseline.modes[mode]!.events = baseline.modes[mode]!.events!.map(event => ({
            ...event,
            id: `synthetic-screen-local-${mode}`,
            doseMG: 1,
        }));
        for (const category of ['labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan'] as const)
            baseline.modes[mode]![category] = [];
        baseline.modes[mode]!.deletions = { events: {}, labResults: {}, doseTemplates: {} };
    }
    return { baseline, incoming };
}

function context(controller: RecordController): RecordContext {
    const state = controller.getState();
    if (state.status !== 'ready' || state.scope.backend !== 'offline' || state.scope.owner !== 'local')
        throw new Error('Offline local qualification scope required');
    return state;
}

/** Setup only. The tested import/export actions must be performed by shared screen controls. */
export async function prepareScreenRecords(controller: RecordController) {
    context(controller);
    await controller.dispatch(current => ({
        changes: Object.entries(current.snapshots).map(([namespace, snapshot]) => ({
            namespace,
            expectedRevision: snapshot.revision,
            puts: {},
            removes: Object.keys(snapshot.entries),
        })),
        result: undefined,
    }));
    await controller.dispatch(current => planCompleteBackup(current, screenFixtures().baseline, 'merge', SCREEN_NOW));
}

/** Read every namespace afresh; do not refresh or mutate the UI controller. */
export async function readScreenRecords(controller: RecordController, store: RecordStore) {
    const current = context(controller);
    await store.initialize();
    const snapshots = Object.fromEntries(
        await Promise.all(
            Object.keys(current.snapshots).map(async namespace => [namespace, await store.read(namespace)]),
        ),
    );
    const fresh = { scope: current.scope, snapshots };
    const report = planRecordOperation(fresh, storage =>
        buildCompleteBackupBundleReportFromStorage(
            storage,
            fresh.scope.owner,
            fresh.scope.mode,
            activeFromSnapshot(storage, fresh),
            new Date(SCREEN_NOW).toISOString(),
            SCREEN_NOW,
        ),
    ).result;
    if (report.issues.length) throw new Error('Synthetic screen export has warnings');
    return { snapshots, snapshot: canonical(snapshots), bundle: report.bundle };
}

export function installScreenMigration(runtime: ApplicationRuntime) {
    const { records } = createNativeStores();
    Object.assign(window, {
        __hrtScreenQualification: {
            prepare: async () => {
                await prepareScreenRecords(runtime.controller);
                runtime.setDevice('app-onboarded', 'true');
                if (!(await runtime.setDevice('hrt-mode', 'transfem')))
                    throw new Error('Unable to select fixture mode');
                runtime.setDevice('app-pixel-cats', 'false');
                return 'ready';
            },
            read: () => readScreenRecords(runtime.controller, records),
            fixture: () => screenFixtures().incoming,
        },
    });
}
