import { createNativeFiles } from '../platform/capacitor/files';
import type { FilePickPort, FileSavePort } from '../platform/contracts/files';
import { ApplicationRuntime, readDevicePreferences } from './runtime';
import { RecordController } from './recordController';
import { DEVICE_PREFERENCES_NAMESPACE, recordNamespace } from '../records/scope';
import { createNativeStores } from '../platform/capacitor';
import { StaleRevisionError, type RecordStore, type SecretStore } from '../platform/contracts';

function commitMode(store: RecordStore, expectedRevision: number, mode: string) {
    return store.commit([
        { namespace: DEVICE_PREFERENCES_NAMESPACE, expectedRevision, puts: { 'hrt-mode': mode }, removes: [] },
    ]);
}

/** Only imported by the explicit native storage builds. */
export async function createNativeRuntime(
    deviceStorage: Pick<Storage, 'getItem' | 'setItem'>,
    stores: { records: RecordStore; secrets: SecretStore } = createNativeStores(),
    documents: FilePickPort & FileSavePort = createNativeFiles(),
): Promise<ApplicationRuntime> {
    const scope = { backend: 'offline', owner: 'local', mode: 'transfem' } as const;
    const controller = new RecordController(stores.records);
    await controller.activate(scope);
    const state = controller.getState();
    if (state.status !== 'ready') throw new Error('Native records unavailable');
    const entries = state.snapshots[recordNamespace(scope)].entries;
    const hasPriorRecords = ['hrt-events', 'hrt-masc-events'].some(key => entries[key] && entries[key] !== '[]');
    const modeSnapshot = await stores.records.read(DEVICE_PREFERENCES_NAMESPACE);
    const nativeMode = modeSnapshot.entries['hrt-mode'];
    const device = readDevicePreferences(deviceStorage, nativeMode);
    const priorMode = device['hrt-mode'];
    if (nativeMode === undefined && (priorMode === 'transfem' || priorMode === 'transmasc')) {
        try {
            await commitMode(stores.records, modeSnapshot.revision, priorMode);
        } catch (error) {
            if (!(error instanceof StaleRevisionError)) throw error;
            // Another startup may have adopted or changed the mode since our read.
            const winner = (await stores.records.read(DEVICE_PREFERENCES_NAMESPACE)).entries['hrt-mode'];
            if (winner === undefined) throw error;
            device['hrt-mode'] = winner;
        }
    }

    let pending = Promise.resolve();
    const saveMode = (mode: string): Promise<void> => {
        const write = pending.then(async () => {
            const snapshot = await stores.records.read(DEVICE_PREFERENCES_NAMESPACE);
            if (snapshot.entries['hrt-mode'] !== mode) await commitMode(stores.records, snapshot.revision, mode);
        });
        // A failed selection must not block a later tap or publish out of order.
        pending = write.catch(() => {});
        return write;
    };
    return new ApplicationRuntime(
        controller,
        scope.backend,
        deviceStorage,
        device,
        hasPriorRecords,
        stores.secrets,
        documents,
        documents,
        saveMode,
    );
}
