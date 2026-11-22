import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    StaleRevisionError,
    type RecordStore,
    type StoreChange,
    type StoreSnapshot,
    type StoreSnapshots,
} from '../contracts';
import { allowedKeys, DEVICE_PREFERENCES_NAMESPACE, PREFERENCES_NAMESPACE, validateChange } from '../../records/scope';
import { LEGACY_AGE_BETA_KEY, nsFor, type StorageLike } from '../../utils/backupState';
import { applyReplaceJournal, recoverReplaceJournal, type ReplaceJournalEntry } from '../../utils/replaceJournal';

export const WEB_STORE_LOCK = 'hrt-record-store-v1';
const META_PREFIX = 'hrt-store-meta-v1:';
type Exclusive = <T>(operation: () => T) => Promise<T>;
const digest = (entries: Readonly<Record<string, string>>) =>
    bytesToHex(
        sha256(
            new TextEncoder().encode(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)))),
        ),
    );
const nextRevision = (revision: number) => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
        throw new Error('Store revision exhausted or invalid');
    return revision + 1;
};

/**
 * Preserves upstream origin-local keys. Each synchronous batch uses the existing
 * recovery journal, including revision metadata and portable preferences.
 * Web Locks serialize cooperating tabs when supplied by the browser runtime.
 * This cannot make old tabs or browsers without Web Locks transactional. Digests
 * detect legacy edits observed before a commit, not races during its writes.
 */
export class WebRecordStore implements RecordStore {
    private initialized = false;
    constructor(
        private readonly storage: StorageLike,
        readonly backend: string,
        private readonly exclusive: Exclusive = operation => Promise.resolve().then(operation),
    ) {}

    initialize(): Promise<void> {
        return this.exclusive(() => {
            recoverReplaceJournal(this.storage);
            this.initialized = true;
        });
    }
    private recover() {
        if (!this.initialized) throw new Error('Record store is not initialized');
        recoverReplaceJournal(this.storage);
    }
    private keys(namespace: string) {
        if (namespace === DEVICE_PREFERENCES_NAMESPACE) throw new Error('Device preferences are native-only');
        const keys = allowedKeys(namespace);
        if (
            namespace !== PREFERENCES_NAMESPACE &&
            JSON.parse(namespace.slice('records:v1:'.length))[0] !== this.backend
        )
            throw new Error('Record namespace belongs to another backend');
        return keys;
    }
    private inspect(namespace: string): StoreSnapshot {
        const entries: Record<string, string> = Object.create(null);
        for (const key of this.keys(namespace)) {
            const value = this.storage.getItem(key);
            if (value !== null) entries[key] = value;
        }
        const raw = this.storage.getItem(META_PREFIX + namespace);
        if (raw === null) return { revision: Object.keys(entries).length ? 1 : 0, entries };
        const meta = JSON.parse(raw);
        if (!meta || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || typeof meta.digest !== 'string')
            throw new Error('Invalid browser record revision');
        return { revision: meta.digest === digest(entries) ? meta.revision : nextRevision(meta.revision), entries };
    }
    private metadata(namespace: string, snapshot: StoreSnapshot): ReplaceJournalEntry {
        return {
            key: META_PREFIX + namespace,
            value: JSON.stringify({ revision: snapshot.revision, digest: digest(snapshot.entries) }),
        };
    }
    private migrateLegacyAgePreference(namespace: string) {
        const owner = JSON.parse(namespace.slice('records:v1:'.length))[1];
        const ageKey = nsFor(owner, 'age-beta');
        const legacyAge = this.storage.getItem(LEGACY_AGE_BETA_KEY);
        if (legacyAge === null || this.storage.getItem(ageKey) !== null) return;
        const current = this.inspect(namespace);
        this.commitNow([{ namespace, expectedRevision: current.revision, puts: { [ageKey]: legacyAge }, removes: [] }]);
    }
    read(namespace: string): Promise<StoreSnapshot> {
        return this.exclusive(() => {
            this.recover();
            this.keys(namespace);
            if (namespace !== PREFERENCES_NAMESPACE) this.migrateLegacyAgePreference(namespace);
            const snapshot = this.inspect(namespace);
            // Record observed legacy changes once; never manufacture record defaults.
            const meta = this.metadata(namespace, snapshot);
            if (snapshot.revision && this.storage.getItem(meta.key) !== meta.value)
                applyReplaceJournal(this.storage, 'revision', [meta]);
            return snapshot;
        });
    }
    commit(changes: readonly StoreChange[]): Promise<StoreSnapshots> {
        // Capture caller-owned inputs before waiting for the lock.
        let captured: StoreChange[];
        try {
            captured = changes.map(change => {
                validateChange(change);
                return { ...change, puts: { ...change.puts }, removes: [...change.removes] };
            });
        } catch (error) {
            return Promise.reject(error);
        }
        return this.exclusive(() => {
            this.recover();
            return this.commitNow(captured);
        });
    }
    private commitNow(changes: readonly StoreChange[]): StoreSnapshots {
        const snapshots: Record<string, StoreSnapshot> = Object.create(null);
        const writes: ReplaceJournalEntry[] = [];
        const physicalKeys = new Set<string>();
        for (const change of changes) {
            validateChange(change);
            this.keys(change.namespace);
            if (Object.hasOwn(snapshots, change.namespace)) throw new Error('Duplicate namespace');
            const before = this.inspect(change.namespace);
            if (before.revision !== change.expectedRevision) throw new StaleRevisionError();
            const entries = { ...before.entries, ...change.puts };
            for (const key of change.removes) delete entries[key];
            const changed = Object.keys(change.puts).length > 0 || change.removes.length > 0;
            const after = { revision: changed ? nextRevision(before.revision) : before.revision, entries };
            snapshots[change.namespace] = after;
            for (const [key, value] of [
                ...Object.entries(change.puts),
                ...change.removes.map(key => [key, null] as const),
            ]) {
                if (physicalKeys.has(key)) throw new Error('Overlapping record keys');
                physicalKeys.add(key);
                writes.push({ key, value });
            }
            if (changed) writes.push(this.metadata(change.namespace, after));
        }
        // Validation above performs no writes, including revision metadata.
        applyReplaceJournal(this.storage, 'records', writes);
        return snapshots;
    }
}
