import { afterEach, expect, it, vi } from 'vitest';
import { RecordController } from '../../src/application/recordController';
import { PREFERENCES_NAMESPACE, recordNamespace } from '../../src/records/scope';
import {
    StaleRevisionError,
    type RecordStore,
    type SecretStore,
    type StoreSnapshot,
} from '../../src/platform/contracts';
import { createNativeRuntime } from '../../src/application/nativeRuntime';

const devices = () => ({
    getItem: vi.fn((key: string) => (key === 'app-onboarded' ? 'true' : null)),
    setItem: vi.fn(),
});
const documents = { pick: async () => null, save: async () => 'saved' as const };
const secrets: SecretStore = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
const namespace = recordNamespace({ backend: 'offline', owner: 'local', mode: 'transfem' });
const seededEntries: Record<string, Record<string, string>> = {
    [namespace]: { 'hrt-masc-events': '[{"id":"synthetic"}]' },
    [PREFERENCES_NAMESPACE]: { 'app-theme': 'dark' },
};
const store = (initialize = async () => {}) =>
    ({
        initialize: vi.fn(initialize),
        read: vi.fn(async (ns: string) => ({
            revision: 2,
            entries: seededEntries[ns] ?? {},
        })),
        commit: vi.fn(),
    }) as RecordStore;

const deviceNamespace = 'device-preferences:v1';

function withModeStore(initial?: string) {
    const records = store();
    const readRecords = records.read;
    let mode = initial;
    let revision = initial === undefined ? 0 : 1;
    const snapshot = (): StoreSnapshot => ({ revision, entries: mode === undefined ? {} : { 'hrt-mode': mode } });
    records.read = vi.fn(async ns => (ns === deviceNamespace ? snapshot() : readRecords(ns)));
    const commit = vi.fn<RecordStore['commit']>(async changes => {
        expect(changes).toHaveLength(1);
        const [change] = changes;
        expect(change.namespace).toBe(deviceNamespace);
        expect(change.expectedRevision).toBe(revision);
        expect(change.removes).toEqual([]);
        mode = change.puts['hrt-mode'];
        revision++;
        return { [deviceNamespace]: snapshot() };
    });
    records.commit = commit;
    return { records, commit, savedMode: () => mode };
}

it('adopts the 1.0.0 mode once and reopens the confirmed selection without reading a stale WebView value', async () => {
    const { records, commit, savedMode } = withModeStore();
    const storage = devices();
    storage.getItem.mockImplementation(key => (key === 'hrt-mode' ? 'transmasc' : null));
    const first = await createNativeRuntime(storage, { records, secrets }, documents);
    expect(first.getState().device['hrt-mode']).toBe('transmasc');
    expect(savedMode()).toBe('transmasc');
    expect(await first.setDevice('hrt-mode', 'transfem')).toBe(true);
    storage.getItem.mockClear();
    const restarted = await createNativeRuntime(storage, { records, secrets }, documents);
    expect(restarted.getState().device['hrt-mode']).toBe('transfem');
    expect(storage.getItem).not.toHaveBeenCalledWith('hrt-mode');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(restarted.getState().preferences).not.toHaveProperty('hrt-mode');
});

it('publishes rapid mode choices in order only after durable writes, and can retry a failed choice', async () => {
    const { records, commit, savedMode } = withModeStore('transfem');
    const runtime = await createNativeRuntime(devices(), { records, secrets }, documents);
    const commitNormally = commit.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
        release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>(resolve => {
        started = resolve;
    });
    commit.mockImplementationOnce(async changes => {
        started();
        await blocked;
        return commitNormally(changes);
    });
    const observed: string[] = [];
    runtime.subscribe(() => observed.push(runtime.getState().device['hrt-mode']));
    const first = runtime.setDevice('hrt-mode', 'transmasc');
    const second = runtime.setDevice('hrt-mode', 'transfem');
    expect(runtime.getState().device['hrt-mode']).toBe('transfem');
    expect(first).toBeInstanceOf(Promise);
    await entered;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([]);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(observed).toEqual(['transmasc', 'transfem']);
    expect(savedMode()).toBe('transfem');

    commit.mockRejectedValueOnce(new Error('synthetic write failure'));
    expect(await runtime.setDevice('hrt-mode', 'transmasc')).toBe(false);
    expect(runtime.getState().device['hrt-mode']).toBe('transfem');
    expect(runtime.getState().error).toBeInstanceOf(Error);
    expect(await runtime.setDevice('hrt-mode', 'transmasc')).toBe(true);
    expect(runtime.getState().error).toBeUndefined();
    expect(savedMode()).toBe('transmasc');
});

it('honors a competing native adoption and propagates a failed migration', async () => {
    const { records, commit } = withModeStore();
    const storage = devices();
    storage.getItem.mockImplementation(key => (key === 'hrt-mode' ? 'transmasc' : null));
    const otherWriter = commit.getMockImplementation()!;
    commit.mockImplementationOnce(async changes => {
        await otherWriter([{ ...changes[0], puts: { 'hrt-mode': 'transfem' } }]);
        throw new StaleRevisionError();
    });
    const runtime = await createNativeRuntime(storage, { records, secrets }, documents);
    expect(runtime.getState().device['hrt-mode']).toBe('transfem');
    const failing = withModeStore();
    failing.commit.mockRejectedValueOnce(new Error('synthetic migration failure'));
    await expect(createNativeRuntime(storage, { records: failing.records, secrets }, documents)).rejects.toThrow(
        'synthetic migration failure',
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

it('awaits native initialization and loaded snapshots before exposing the runtime', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const records = store(() => gate);
    const storage = devices();
    let ready = false;
    const opening = createNativeRuntime(storage, { records, secrets }, documents).then(runtime => {
        ready = true;
        return runtime;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(records.read).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    release();
    const runtime = await opening;
    expect(runtime.controller).toBeInstanceOf(RecordController);
    expect(runtime.controller.getState().status).toBe('ready');
    expect(runtime.backend).toBe('offline');
    expect(runtime.hasPriorRecords).toBe(true);
    expect(runtime.getState().preferences).toEqual({ 'app-theme': 'dark' });
    expect(runtime.getState().device).toEqual({ 'app-onboarded': 'true' });
    expect(runtime.secrets).toBe(secrets);
    expect(storage.getItem.mock.calls.every(([key]) => !key.includes('events') && key !== 'auth_token')).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
});

it('propagates native recovery failure without reading browser records or creating a runtime', async () => {
    const storage = devices();
    const records = store(async () => {
        throw new Error('synthetic unavailable');
    });
    await expect(createNativeRuntime(storage, { records, secrets }, documents)).rejects.toThrow(
        'synthetic unavailable',
    );
    expect(records.read).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
});

it('blocks a qualification build in an unsupported browser instead of silently choosing the web store', async () => {
    vi.stubGlobal('__HRT_NATIVE_RECORDS__', true);
    const { createApplicationRuntime } = await import('../../src/application/bootstrap');
    const storage = devices();
    await expect(createApplicationRuntime(storage as unknown as Storage, 'https://localhost')).rejects.toThrow();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
});
