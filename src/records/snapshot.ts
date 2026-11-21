import type { StoreChange, StoreSnapshots } from '../platform/contracts';
import type { StorageLike } from '../utils/backupState';
import { REPLACE_JOURNAL_KEY } from '../utils/replaceJournal';
import { allowedKeys, namespacesFor, validateSnapshot, type RecordScope } from './scope';

export interface RecordContext {
    readonly scope: RecordScope;
    readonly snapshots: StoreSnapshots;
}
export interface RecordPlan<T> {
    readonly changes: readonly StoreChange[];
    readonly result: T;
}
export type RecordOperation<T> = (context: RecordContext) => RecordPlan<T>;

/**
 * Execute upstream StorageLike helpers only against a disposable overlay.
 * Both namespaces remain in the read set, even if one has no mutations.
 * Callbacks must be synchronous; they must not retain the overlay or do I/O.
 */
export function planRecordOperation<T>(context: RecordContext, operation: (storage: StorageLike) => T): RecordPlan<T> {
    const namespaces = namespacesFor(context.scope);
    if (Object.keys(context.snapshots).length !== namespaces.length) throw new Error('Unexpected snapshot namespaces');
    const values = new Map<string, string>();
    const keySets = namespaces.map(namespace => {
        const snapshot = context.snapshots[namespace];
        if (!snapshot) throw new Error('Missing snapshot');
        validateSnapshot(namespace, snapshot);
        for (const [key, value] of Object.entries(snapshot.entries)) values.set(key, value);
        return allowedKeys(namespace);
    });
    // The legacy replace helper journals inside this overlay. The transient
    // journal is never exposed as a durable entry or replayed by a native store.
    const check = (key: string) => {
        if (key !== REPLACE_JOURNAL_KEY && !keySets.some(keys => keys.has(key)))
            throw new Error('Record key outside scope');
    };
    const result = operation({
        getItem(key) {
            check(key);
            return values.get(key) ?? null;
        },
        setItem(key, value) {
            check(key);
            if (typeof value !== 'string') throw new Error('Invalid record value');
            values.set(key, value);
        },
        removeItem(key) {
            check(key);
            values.delete(key);
        },
    });
    if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('Record planners must be synchronous');
    if (values.has(REPLACE_JOURNAL_KEY)) throw new Error('Incomplete in-memory replace');
    const changes = namespaces.map((namespace, i): StoreChange => {
        const snapshot = context.snapshots[namespace];
        const puts: Record<string, string> = Object.create(null);
        const removes: string[] = [];
        for (const key of keySets[i]) {
            const previous = Object.hasOwn(snapshot.entries, key) ? snapshot.entries[key] : undefined;
            const next = values.get(key);
            if (previous === next) continue;
            if (next === undefined) removes.push(key);
            else puts[key] = next;
        }
        return { namespace, expectedRevision: snapshot.revision, puts, removes };
    });
    return { result, changes };
}
