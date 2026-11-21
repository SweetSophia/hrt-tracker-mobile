import { RecordController } from './recordController';
import { WebRecordStore, WEB_STORE_LOCK } from '../platform/web/recordStore';
import { WebFileSavePort, WebFilePickPort } from '../platform/web/files';
import { PREFERENCES_NAMESPACE, PORTABLE_PREFERENCE_KEYS } from '../records/scope';
import { planRecordOperation } from '../records';
import { clearAccountHealthData } from '../utils/backupState';
import type { SecretStore } from '../platform/contracts';
import type { FileSavePort, FilePickPort } from '../platform/contracts/files';

export const DEVICE_KEYS = [
    'hrt-mode',
    'app-auto-backup',
    'app-dev-mode',
    'app-pixel-cats',
    'app-pixel-cat-style',
    'app-onboarded',
    'site-notice-dismissed',
    'js-dependency-notice-dismissed',
] as const;
export type DeviceKey = (typeof DEVICE_KEYS)[number];
export type PortableKey = (typeof PORTABLE_PREFERENCE_KEYS)[number];

/** Initialized once before React (including StrictMode) is mounted. */
export class ApplicationRuntime {
    private listeners = new Set<() => void>();
    private view: {
        preferences: Readonly<Record<string, string>>;
        device: Readonly<Record<string, string>>;
        error?: unknown;
    };
    constructor(
        readonly controller: RecordController,
        readonly backend: string,
        private readonly storage: Pick<Storage, 'setItem'>,
        device: Record<string, string>,
        readonly hasPriorRecords: boolean,
        readonly secrets?: SecretStore,
        readonly files: FileSavePort = new WebFileSavePort(),
        readonly filePicker: FilePickPort = new WebFilePickPort(),
    ) {
        const state = controller.getState();
        if (state.status !== 'ready') throw new Error('Runtime must be initialized');
        this.view = { preferences: state.snapshots[PREFERENCES_NAMESPACE].entries, device };
        controller.subscribe(() => {
            const state = controller.getState();
            if (state.status === 'ready')
                this.view = { ...this.view, preferences: state.snapshots[PREFERENCES_NAMESPACE].entries };
            this.emit();
        });
    }
    private emit() {
        for (const listener of this.listeners) listener();
    }
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    getState = () => this.view;
    setDevice(key: DeviceKey, value: string): boolean {
        if (!DEVICE_KEYS.includes(key)) throw new Error('Unknown device preference');
        try {
            this.storage.setItem(key, value);
            this.view = { ...this.view, device: { ...this.view.device, [key]: value }, error: undefined };
            this.emit();
            return true;
        } catch (error) {
            this.view = { ...this.view, error };
            this.emit();
            return false;
        }
    }
    async setPreference(key: PortableKey, value: string): Promise<boolean> {
        if (!PORTABLE_PREFERENCE_KEYS.includes(key)) throw new Error('Unknown portable preference');
        try {
            const receipt = await this.controller.dispatch(context =>
                planRecordOperation(context, storage => storage.setItem(key, value)),
            );
            return receipt.active;
        } catch {
            return false;
        }
    }

    async clearSignedInRecords(owner: string): Promise<void> {
        const state = this.controller.getState();
        if (owner === 'local' || state.status !== 'ready' || state.scope.owner !== owner) {
            throw new Error('Record scope changed');
        }
        const clearing = this.controller.dispatch(context =>
            planRecordOperation(context, storage => clearAccountHealthData(storage, owner)),
        );
        // Finish writes already admitted for this account, then wipe it. Hide
        // its scope immediately so a retained UI callback cannot edit it again.
        void this.controller.activate({ ...state.scope, owner: 'local' }).catch(() => undefined);
        await clearing;
    }
}

export function readDevicePreferences(storage: Pick<Storage, 'getItem'>): Record<string, string> {
    const device: Record<string, string> = {};
    for (const key of DEVICE_KEYS) {
        const value = storage.getItem(key);
        if (value !== null) device[key] = value;
    }
    return device;
}

export async function createWebRuntime(
    storage: Storage,
    backend: string,
    locks?: LockManager,
): Promise<ApplicationRuntime> {
    const store = new WebRecordStore(
        storage,
        backend,
        locks ? operation => locks.request(WEB_STORE_LOCK, operation) : undefined,
    );
    const controller = new RecordController(store);
    await controller.activate({ backend, owner: 'local', mode: 'transfem' });
    const device = readDevicePreferences(storage);
    // Keep the old first-run rule as a boolean, without exposing another account's records to React.
    let hasPriorRecords = false;
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || !/^hrt-(u[^-]+-)?(masc-)?events$/.test(key)) continue;
        const value = storage.getItem(key);
        if (value && value !== '[]') hasPriorRecords = true;
    }
    return new ApplicationRuntime(controller, backend, storage, device, hasPriorRecords);
}
