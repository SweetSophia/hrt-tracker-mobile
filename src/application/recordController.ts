import { StaleRevisionError, type RecordStore, type StoreChange, type StoreSnapshots } from '../platform/contracts';
import type { RecordOperation } from '../records/snapshot';
import { namespacesFor, recordNamespace, validateChange, validateSnapshot, type RecordScope } from '../records/scope';

export type RecordControllerState =
    | { readonly status: 'idle' }
    | { readonly status: 'loading'; readonly scope: RecordScope }
    | { readonly status: 'error'; readonly scope: RecordScope; readonly error: unknown }
    | {
          readonly status: 'ready';
          readonly scope: RecordScope;
          readonly snapshots: StoreSnapshots;
          readonly error?: unknown;
      };

interface Session {
    readonly generation: number;
    readonly scope: RecordScope;
    snapshots: StoreSnapshots;
    needsRefresh: boolean;
}

function copySnapshots(scope: RecordScope, source: StoreSnapshots): StoreSnapshots {
    const namespaces = namespacesFor(scope);
    if (Object.keys(source).length !== namespaces.length) throw new Error('Unexpected snapshot namespaces');
    const copies = Object.create(null);
    for (const namespace of namespaces) {
        const snapshot = source[namespace];
        if (!snapshot) throw new Error('Missing store snapshot');
        validateSnapshot(namespace, snapshot);
        copies[namespace] = Object.freeze({
            revision: snapshot.revision,
            entries: Object.freeze({ ...snapshot.entries }),
        });
    }
    return Object.freeze(copies);
}

function checkedChanges(session: Session, source: readonly StoreChange[]): readonly StoreChange[] {
    const expected = new Set(namespacesFor(session.scope));
    if (source.length !== expected.size) throw new Error('Incomplete record read set');
    const copies = source.map(change => {
        validateChange(change);
        if (
            !expected.delete(change.namespace) ||
            change.expectedRevision !== session.snapshots[change.namespace].revision
        ) {
            throw new Error('Change outside captured snapshot');
        }
        if (
            (Object.keys(change.puts).length || change.removes.length) &&
            change.expectedRevision === Number.MAX_SAFE_INTEGER
        ) {
            throw new Error('Store revision exhausted');
        }
        return Object.freeze({
            ...change,
            puts: Object.freeze({ ...change.puts }),
            removes: Object.freeze([...change.removes]),
        });
    });
    return Object.freeze(copies);
}

function checkAcknowledgement(before: StoreSnapshots, changes: readonly StoreChange[], after: StoreSnapshots): void {
    for (const change of changes) {
        const snapshot = after[change.namespace];
        const expected = { ...before[change.namespace].entries, ...change.puts };
        for (const key of change.removes) delete expected[key];
        const revision = change.expectedRevision + (Object.keys(change.puts).length || change.removes.length ? 1 : 0);
        if (
            snapshot.revision !== revision ||
            Object.keys(snapshot.entries).length !== Object.keys(expected).length ||
            Object.entries(expected).some(([key, value]) => snapshot.entries[key] !== value)
        ) {
            throw new Error('Store snapshot does not acknowledge the requested change');
        }
    }
}

/**
 * Framework-independent coordinator. One instance belongs to one application
 * runtime. React can subscribe via useSyncExternalStore in the later adapter.
 * A scope switch hides old state immediately, but admitted writes finish in
 * their original scope. Receipts mark stale completions for callers with UI.
 */
export class RecordController {
    private state: RecordControllerState = Object.freeze({ status: 'idle' });
    private listeners = new Set<() => void>();
    private tail: Promise<unknown> = Promise.resolve();
    private initialization?: Promise<void>;
    private generation = 0;
    private session?: Session;
    private activation?: { key: string; promise: Promise<void> };

    constructor(private readonly store: RecordStore) {}

    getState = (): RecordControllerState => this.state;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private publish(state: RecordControllerState): void {
        this.state = Object.freeze(state);
        for (const listener of [...this.listeners]) {
            // A view failure cannot turn a durable commit into a storage failure
            // or prevent other subscribers from seeing confirmed state.
            try {
                listener();
            } catch {
                /* Subscriber owns its error handling. */
            }
        }
    }
    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        const task = this.tail.then(run);
        this.tail = task.catch(() => undefined);
        return task;
    }
    private initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = Promise.resolve()
                .then(() => this.store.initialize())
                .catch(error => {
                    this.initialization = undefined;
                    throw error;
                });
        }
        return this.initialization;
    }

    activate(scope: RecordScope): Promise<void> {
        return this.load(scope, false);
    }
    refresh(): Promise<void> {
        if (this.state.status === 'idle') return Promise.reject(new Error('No active record scope'));
        return this.load(this.state.scope, true);
    }
    private load(input: RecordScope, force: boolean): Promise<void> {
        const scope = Object.freeze({ ...input });
        const key = JSON.stringify([recordNamespace(scope), scope.mode]);
        if (!force && this.activation?.key === key && this.state.status !== 'error') return this.activation.promise;
        const generation = ++this.generation;
        this.session = undefined;
        const promise = this.enqueue(async () => {
            try {
                await this.initialize();
                const entries = await Promise.all(
                    namespacesFor(scope).map(async namespace => [namespace, await this.store.read(namespace)] as const),
                );
                const snapshots = copySnapshots(scope, Object.fromEntries(entries));
                if (generation !== this.generation) return;
                this.session = { generation, scope, snapshots, needsRefresh: false };
                this.publish({ status: 'ready', scope, snapshots });
            } catch (error) {
                if (generation === this.generation) this.publish({ status: 'error', scope, error });
                throw error;
            }
        });
        this.activation = { key, promise };
        this.publish({ status: 'loading', scope });
        return promise;
    }

    dispatch<T>(operation: RecordOperation<T>): Promise<{ result: T; active: boolean }> {
        const session = this.session;
        if (this.state.status !== 'ready' || !session)
            return Promise.reject(new Error('Record controller is not ready'));
        return this.enqueue(async () => {
            try {
                if (session.needsRefresh) throw new Error('Refresh records before trying again.');
                const plan = operation({ scope: session.scope, snapshots: session.snapshots });
                const changes = checkedChanges(session, plan.changes);
                const acknowledgement = await this.store.commit(changes);
                // A malformed acknowledgement leaves durability uncertain. Keep
                // the previous confirmed UI and require an explicit reread.
                session.needsRefresh = true;
                const snapshots = copySnapshots(session.scope, acknowledgement);
                checkAcknowledgement(session.snapshots, changes, snapshots);
                session.snapshots = snapshots;
                session.needsRefresh = false;
                if (session.generation === this.generation)
                    this.publish({ status: 'ready', scope: session.scope, snapshots });
                return { result: plan.result, active: session.generation === this.generation };
            } catch (error) {
                if (error instanceof StaleRevisionError) session.needsRefresh = true;
                if (session.generation === this.generation) {
                    this.publish({ status: 'ready', scope: session.scope, snapshots: session.snapshots, error });
                }
                throw error;
            }
        });
    }
}
