import type { RecordStore, StoreChange, StoreSnapshot, StoreSnapshots } from '../contracts';
import { PREFERENCES_NAMESPACE, validateChange, validateSnapshot } from '../../records/scope';
import {
    NATIVE_INITIALIZE_TIMEOUT_MS,
    invokeNative,
    isRecord,
    nativeStorageUnavailable,
    type NativeStorageBridge,
} from './bridge';

const OFFLINE_BACKEND = 'offline';

function assertOfflineNamespace(namespace: string): void {
    if (namespace === PREFERENCES_NAMESPACE) return;
    let parts: unknown;
    try {
        parts = JSON.parse(namespace.slice('records:v1:'.length));
    } catch {
        throw new Error('Invalid record namespace');
    }
    if (!Array.isArray(parts) || parts[0] !== OFFLINE_BACKEND) {
        throw new Error('Record namespace belongs to another backend');
    }
}

function captureChanges(changes: readonly StoreChange[]): StoreChange[] {
    if (!Array.isArray(changes)) throw new Error('Invalid record changes');
    const captured = changes.map(change => {
        validateChange(change);
        assertOfflineNamespace(change.namespace);
        return {
            namespace: change.namespace,
            expectedRevision: change.expectedRevision,
            puts: { ...change.puts },
            removes: [...change.removes],
        };
    });
    const namespaces = new Set<string>();
    for (const change of captured) {
        if (namespaces.has(change.namespace)) throw new Error('Duplicate namespace');
        namespaces.add(change.namespace);
        const changed = Object.keys(change.puts).length > 0 || change.removes.length > 0;
        if (changed && change.expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error('Store revision exhausted');
    }
    return captured;
}

function freezeSnapshot(namespace: string, raw: unknown): StoreSnapshot {
    if (
        !isRecord(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, 'revision') ||
        !Object.hasOwn(raw, 'entries')
    ) {
        throw nativeStorageUnavailable();
    }
    const { revision, entries } = raw;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || !isRecord(entries)) {
        throw nativeStorageUnavailable();
    }
    const copy: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== 'string') throw nativeStorageUnavailable();
        copy[key] = value;
    }
    try {
        validateSnapshot(namespace, { revision, entries: copy });
    } catch {
        throw nativeStorageUnavailable();
    }
    return Object.freeze({ revision, entries: Object.freeze(copy) });
}

function acknowledge(changes: readonly StoreChange[], raw: unknown): StoreSnapshots {
    if (!isRecord(raw)) throw nativeStorageUnavailable();
    const names = changes.map(change => change.namespace);
    if (Object.keys(raw).length !== names.length || names.some(name => !Object.hasOwn(raw, name))) {
        throw nativeStorageUnavailable();
    }
    const snapshots: Record<string, StoreSnapshot> = Object.create(null);
    for (const change of changes) {
        const snapshot = freezeSnapshot(change.namespace, raw[change.namespace]);
        const changed = Object.keys(change.puts).length > 0 || change.removes.length > 0;
        if (snapshot.revision !== change.expectedRevision + (changed ? 1 : 0)) throw nativeStorageUnavailable();
        for (const [key, value] of Object.entries(change.puts)) {
            if (snapshot.entries[key] !== value) throw nativeStorageUnavailable();
        }
        for (const key of change.removes) {
            if (Object.hasOwn(snapshot.entries, key)) throw nativeStorageUnavailable();
        }
        snapshots[change.namespace] = snapshot;
    }
    return Object.freeze(snapshots);
}

export class NativeRecordStore implements RecordStore {
    private pending: Promise<void> | null = null;
    private ready = false;

    constructor(private readonly bridge: NativeStorageBridge) {}

    initialize(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (!this.pending) this.pending = this.performInitialize();
        return this.pending;
    }

    private performInitialize(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const execution = invokeNative(this.bridge, 'initialize', {}).then(result => {
            if (!isRecord(result) || Object.keys(result).length !== 1 || result.backend !== OFFLINE_BACKEND) {
                throw nativeStorageUnavailable();
            }
        });
        const timeout = new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => reject(nativeStorageUnavailable()), NATIVE_INITIALIZE_TIMEOUT_MS);
        });
        const outcome = Promise.race([execution, timeout]);
        void execution.catch(() => undefined);
        return outcome
            .then(() => {
                this.ready = true;
            })
            .catch((error: unknown) => {
                this.pending = null;
                throw error instanceof Error ? error : nativeStorageUnavailable();
            })
            .finally(() => {
                if (timer !== undefined) clearTimeout(timer);
            });
    }

    private async gate(): Promise<void> {
        if (this.ready) return;
        if (!this.pending) throw new Error('Record store is not initialized');
        await this.pending;
    }

    async read(namespace: string): Promise<StoreSnapshot> {
        validateSnapshot(namespace, { revision: 0, entries: {} });
        assertOfflineNamespace(namespace);
        await this.gate();
        return freezeSnapshot(namespace, await invokeNative(this.bridge, 'read', { namespace }));
    }

    async commit(changes: readonly StoreChange[]): Promise<StoreSnapshots> {
        const captured = captureChanges(changes);
        await this.gate();
        return acknowledge(captured, await invokeNative(this.bridge, 'commit', { changes: captured }));
    }
}
