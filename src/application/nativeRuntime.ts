import { createNativeFiles } from '../platform/capacitor/files';
import type { FilePickPort, FileSavePort } from '../platform/contracts/files';
import { ApplicationRuntime, readDevicePreferences } from './runtime';
import { RecordController } from './recordController';
import { recordNamespace } from '../records/scope';
import { createNativeStores } from '../platform/capacitor';
import type { RecordStore, SecretStore } from '../platform/contracts';

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
    return new ApplicationRuntime(
        controller,
        scope.backend,
        deviceStorage,
        readDevicePreferences(deviceStorage),
        hasPriorRecords,
        stores.secrets,
        documents,
        documents,
    );
}
