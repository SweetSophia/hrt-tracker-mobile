import { afterEach, expect, it, vi } from 'vitest';
import { RecordController } from '../../src/application/recordController';
import { recordNamespace } from '../../src/records/scope';
import type { RecordStore, SecretStore } from '../../src/platform/contracts';
import { createNativeRuntime } from '../../src/application/nativeRuntime';

const devices = () => ({
    getItem: vi.fn((key: string) => (key === 'app-onboarded' ? 'true' : null)),
    setItem: vi.fn(),
});
const documents = { pick: async () => null, save: async () => 'saved' as const };
const secrets: SecretStore = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
const namespace = recordNamespace({ backend: 'offline', owner: 'local', mode: 'transfem' });
const store = (initialize = async () => {}) =>
    ({
        initialize: vi.fn(initialize),
        read: vi.fn(async (ns: string) => ({
            revision: 2,
            entries: ns === namespace ? { 'hrt-masc-events': '[{"id":"synthetic"}]' } : { 'app-theme': 'dark' },
        })),
        commit: vi.fn(),
    }) as RecordStore;

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
