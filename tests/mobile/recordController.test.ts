import { expect, it, vi } from 'vitest';
import { RecordController } from '../../src/application/recordController';
import {
    StaleRevisionError,
    type RecordStore,
    type StoreChange,
    type StoreSnapshot,
    type StoreSnapshots,
} from '../../src/platform/contracts';
import { planRecordOperation } from '../../src/records';
import {
    namespacesFor,
    PREFERENCES_NAMESPACE,
    recordNamespace,
    validateChange,
    type RecordScope,
} from '../../src/records/scope';
import { nsFor } from '../../src/utils/backupState';

const scope: RecordScope = { backend: 'offline', owner: 'local', mode: 'transfem' };
const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
};

/** Test double only: atomic CAS semantics, explicit fault/delay injection. */
class TestStore implements RecordStore {
    data = new Map<string, StoreSnapshot>();
    initialize = vi.fn(async () => {});
    read = vi.fn(async (namespace: string): Promise<StoreSnapshot> =>
        structuredClone(this.data.get(namespace) ?? { revision: 0, entries: {} }),
    );
    commit = vi.fn(async (changes: readonly StoreChange[]): Promise<StoreSnapshots> => {
        const next: Record<string, StoreSnapshot> = {};
        for (const change of changes) {
            validateChange(change);
            const current = this.data.get(change.namespace) ?? { revision: 0, entries: {} };
            if (current.revision !== change.expectedRevision) throw new StaleRevisionError();
            if (Object.hasOwn(next, change.namespace)) throw new Error('Duplicate namespace');
            const entries = { ...current.entries, ...change.puts };
            for (const key of change.removes) delete entries[key];
            next[change.namespace] = {
                revision: current.revision + (Object.keys(change.puts).length || change.removes.length ? 1 : 0),
                entries,
            };
        }
        for (const [namespace, snapshot] of Object.entries(next)) this.data.set(namespace, snapshot);
        return structuredClone(next);
    });
}
const increment = (context: Parameters<typeof planRecordOperation>[0]) =>
    planRecordOperation(context, storage => {
        const key = nsFor(context.scope.owner, 'weight');
        const value = Number(storage.getItem(key) ?? 70) + 1;
        storage.setItem(key, String(value));
        return value;
    });
const weight = (controller: RecordController) => {
    const state = controller.getState();
    if (state.status !== 'ready') return undefined;
    return state.snapshots[recordNamespace(state.scope)].entries[nsFor(state.scope.owner, 'weight')];
};

it('deduplicates StrictMode activation and never writes before hydration finishes', async () => {
    const store = new TestStore();
    const gate = defer();
    store.initialize.mockImplementationOnce(() => gate.promise);
    const controller = new RecordController(store);
    const first = controller.activate(scope);
    const second = controller.activate({ ...scope });
    expect(controller.getState().status).toBe('loading');
    await expect(controller.dispatch(increment)).rejects.toThrow(/ready/);
    await vi.waitFor(() => expect(store.initialize).toHaveBeenCalledTimes(1));
    expect(store.read).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second]);
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.commit).not.toHaveBeenCalled();
    expect(weight(controller)).toBeUndefined();
});

it.each(['initialize', 'read'] as const)(
    'recovers from %s failure without hiding it or writing defaults',
    async operation => {
        const store = new TestStore();
        store[operation].mockRejectedValueOnce(new Error('synthetic failure'));
        const controller = new RecordController(store);
        await expect(controller.activate(scope)).rejects.toThrow('synthetic failure');
        expect(controller.getState().status).toBe('error');
        expect(store.commit).not.toHaveBeenCalled();
        await controller.activate(scope);
        expect(controller.getState().status).toBe('ready');
    },
);

it('serializes rapid edits against the last committed snapshot without optimistic publication', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    const gate = defer();
    const commit = store.commit.getMockImplementation()!;
    store.commit.mockImplementationOnce(async changes => {
        await gate.promise;
        return commit(changes);
    });
    const first = controller.dispatch(increment);
    const second = controller.dispatch(increment);
    await vi.waitFor(() => expect(store.commit).toHaveBeenCalledTimes(1));
    expect(weight(controller)).toBeUndefined();
    gate.resolve();
    expect(await first).toEqual({ result: 71, active: true });
    expect(await second).toEqual({ result: 72, active: true });
    expect(weight(controller)).toBe('72');
    expect(store.commit.mock.calls[1][0][0].expectedRevision).toBe(1);
});

it('rejects a failed commit without publishing it and keeps later edits usable', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    store.commit.mockRejectedValueOnce(new Error('synthetic disk full'));
    await expect(controller.dispatch(increment)).rejects.toThrow('synthetic disk full');
    expect(weight(controller)).toBeUndefined();
    expect(controller.getState()).toHaveProperty('error');
    expect(await controller.dispatch(increment)).toEqual({ result: 71, active: true });
    expect(controller.getState()).not.toHaveProperty('error');
});

it('requires refresh after a stale revision and never automatically replays an operation', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    store.data.set(recordNamespace(scope), { revision: 1, entries: { 'hrt-weight': '90' } });
    const operation = vi.fn(increment);
    await expect(controller.dispatch(operation)).rejects.toBeInstanceOf(StaleRevisionError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(weight(controller)).toBeUndefined();
    await expect(controller.dispatch(operation)).rejects.toThrow(/refresh/i);
    await controller.refresh();
    expect(weight(controller)).toBe('90');
    expect(await controller.dispatch(operation)).toEqual({ result: 91, active: true });
});

it('guards an unchanged preferences dependency atomically with record mutations', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    store.data.set(PREFERENCES_NAMESPACE, { revision: 1, entries: { 'app-theme': 'dark' } });
    await expect(controller.dispatch(increment)).rejects.toBeInstanceOf(StaleRevisionError);
    expect(store.data.has(recordNamespace(scope))).toBe(false);
    expect(weight(controller)).toBeUndefined();
});

it('does not publish a stale hydration after the active account changes', async () => {
    const store = new TestStore();
    const gate = defer();
    const read = store.read.getMockImplementation()!;
    store.read.mockImplementationOnce(async namespace => {
        await gate.promise;
        return read(namespace);
    });
    const controller = new RecordController(store);
    const states: string[] = [];
    controller.subscribe(() => {
        const state = controller.getState();
        if (state.status === 'ready') states.push(state.scope.owner);
    });
    const first = controller.activate(scope);
    await vi.waitFor(() => expect(store.read).toHaveBeenCalled());
    const second = controller.activate({ ...scope, owner: '42' });
    gate.resolve();
    await Promise.all([first, second]);
    expect(states).toEqual(['42']);
});

it.each([
    { ...scope, owner: '42' },
    { ...scope, mode: 'transmasc' as const },
    { ...scope, backend: 'https://synthetic.invalid' },
])('finishes admitted writes in their captured scope while suppressing stale completion: %j', async nextScope => {
    const store = new TestStore();
    const controller = new RecordController(store);
    const mutable = { ...scope };
    await controller.activate(mutable);
    const gate = defer();
    const commit = store.commit.getMockImplementation()!;
    store.commit.mockImplementationOnce(async changes => {
        await gate.promise;
        return commit(changes);
    });
    const first = controller.dispatch(increment);
    const second = controller.dispatch(increment);
    await vi.waitFor(() => expect(store.commit).toHaveBeenCalledTimes(1));
    const switched = controller.activate(nextScope);
    mutable.owner = 'changed-by-caller';
    expect(controller.getState().status).toBe('loading');
    gate.resolve();
    expect(await first).toEqual({ result: 71, active: false });
    expect(await second).toEqual({ result: 72, active: false });
    await switched;
    expect(store.data.get(recordNamespace(scope))?.entries['hrt-weight']).toBe('72');
    expect(controller.getState()).toHaveProperty('scope', nextScope);
    expect(weight(controller)).toBe(recordNamespace(nextScope) === recordNamespace(scope) ? '72' : undefined);
});

it('rejects planner changes outside the captured read set before calling the store', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    for (const mutate of [
        (changes: StoreChange[]) => changes.pop(),
        (changes: StoreChange[]) => changes.push(changes[0]),
        (changes: StoreChange[]) => {
            changes[0] = { ...changes[0], namespace: recordNamespace({ ...scope, owner: '42' }) };
        },
        (changes: StoreChange[]) => {
            changes[0] = { ...changes[0], expectedRevision: 99 };
        },
        (changes: StoreChange[]) => {
            changes[0] = { ...changes[0], puts: { token: 'synthetic' } };
        },
    ]) {
        await expect(
            controller.dispatch(context => {
                const plan = increment(context);
                const changes = [...plan.changes];
                mutate(changes);
                return { ...plan, changes };
            }),
        ).rejects.toThrow();
    }
    expect(store.commit).not.toHaveBeenCalled();
});

it('isolates subscriber failures and prevents caller or adapter mutation of confirmed state', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    controller.subscribe(() => {
        throw new Error('synthetic listener');
    });
    const subscriber = vi.fn();
    const unsubscribe = controller.subscribe(subscriber);
    await controller.activate(scope);
    await controller.dispatch(increment);
    expect(weight(controller)).toBe('71');
    const state = controller.getState();
    if (state.status !== 'ready') throw new Error('not ready');
    expect(() => Object.assign(state.snapshots[recordNamespace(scope)].entries, { 'hrt-weight': '999' })).toThrow();
    expect(() => Object.assign(state.scope, { owner: '42' })).toThrow();
    expect(() => Object.assign(state, { status: 'idle' })).toThrow();
    Object.assign(store.data.get(recordNamespace(scope))!.entries, { 'hrt-weight': '999' });
    expect(weight(controller)).toBe('71');
    unsubscribe();
    const calls = subscriber.mock.calls.length;
    await controller.refresh();
    expect(subscriber).toHaveBeenCalledTimes(calls);
});

it('requires refresh after an invalid commit acknowledgement', async () => {
    const store = new TestStore();
    const controller = new RecordController(store);
    await controller.activate(scope);
    store.commit.mockResolvedValueOnce({});
    await expect(controller.dispatch(increment)).rejects.toThrow(/snapshot/i);
    expect(weight(controller)).toBeUndefined();
    await expect(controller.dispatch(increment)).rejects.toThrow(/refresh/i);
    await controller.refresh();
    await controller.dispatch(increment);
    expect(weight(controller)).toBe('71');
});

it('rejects a store snapshot containing credentials before publication', async () => {
    const store = new TestStore();
    store.data.set(namespacesFor(scope)[0], { revision: 0, entries: { token: 'synthetic' } });
    const controller = new RecordController(store);
    await expect(controller.activate(scope)).rejects.toThrow(/entry/);
    expect(controller.getState().status).toBe('error');
    expect(controller.getState()).not.toHaveProperty('snapshots');
});
