import { afterEach, describe, expect, it, vi } from 'vitest';
import * as capacitor from '@capacitor/core';
import { StaleRevisionError, type StoreChange } from '../../src/platform/contracts';
import { createNativeStores, NativeRecordStore, NativeSecretStore } from '../../src/platform/capacitor';
import {
    NATIVE_INITIALIZE_TIMEOUT_MS,
    NATIVE_STORAGE_PLUGIN,
    NATIVE_STORAGE_UNAVAILABLE,
    type NativeStorageRequest,
    type NativeStorageResponse,
} from '../../src/platform/capacitor/bridge';
import { DEVICE_PREFERENCES_NAMESPACE, PREFERENCES_NAMESPACE, recordNamespace } from '../../src/records/scope';
import { modeKeyFor } from '../../src/utils/backupState';

class FakeBridge {
    readonly requests: NativeStorageRequest[] = [];
    handler: (request: NativeStorageRequest) => Promise<NativeStorageResponse> | NativeStorageResponse = () => {
        throw new Error('unexpected native call');
    };
    execute(request: NativeStorageRequest): Promise<NativeStorageResponse> {
        this.requests.push(request);
        return Promise.resolve().then(() => this.handler(request));
    }
}

const offline = (owner = 'local') => recordNamespace({ backend: 'offline', owner, mode: 'transfem' });
const payload = (value: unknown): NativeStorageResponse => ({ version: 1, payload: JSON.stringify(value) });
const weight = (owner = 'local'): StoreChange => ({
    namespace: offline(owner),
    expectedRevision: 0,
    puts: { [owner === 'local' ? 'hrt-weight' : `hrt-u${owner}-weight`]: '70' },
    removes: [],
});

async function initialized(bridge = new FakeBridge()) {
    bridge.handler = () => payload({ backend: 'offline' });
    const records = new NativeRecordStore(bridge);
    await records.initialize();
    bridge.requests.length = 0;
    return { bridge, records, secrets: new NativeSecretStore(bridge) };
}

async function rejection(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected rejection');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
});

describe('native storage adapters', () => {
    it('rejects use before initialization without calling the bridge', async () => {
        const bridge = new FakeBridge();
        const records = new NativeRecordStore(bridge);
        await expect(records.read(offline())).rejects.toThrow('Record store is not initialized');
        await expect(records.commit([weight()])).rejects.toThrow('Record store is not initialized');
        expect(bridge.requests).toEqual([]);
    });

    it('rejects malformed record input before transport', async () => {
        const { bridge, records } = await initialized();
        const samples: unknown[] = [
            undefined,
            [weight('local'), weight('local')],
            [{ ...weight(), puts: { 'hrt-weight': '70' }, removes: ['hrt-weight'] }],
            [{ ...weight(), namespace: recordNamespace({ backend: 'web', owner: 'local', mode: 'transfem' }) }],
            [{ ...weight(), expectedRevision: -1 }],
            [{ ...weight(), puts: { auth_token: 'synthetic-secret' } }],
            [{ ...weight(), expectedRevision: 1.5 }],
        ];
        for (const changes of samples) await expect(records.commit(changes as never)).rejects.toThrow();
        await expect(records.read('records:v1:not-json')).rejects.toThrow();
        expect(bridge.requests).toEqual([]);
    });

    it('sends identical key strings that belong to different namespaces', async () => {
        const { bridge, records } = await initialized();
        const shared = modeKeyFor('a', 'transmasc', 'events');
        expect(modeKeyFor('a-masc', 'transfem', 'events')).toBe(shared);
        const changes: StoreChange[] = [
            { namespace: offline('a'), expectedRevision: 0, puts: { [shared]: '[]' }, removes: [] },
            { namespace: offline('a-masc'), expectedRevision: 0, puts: { [shared]: '[]' }, removes: [] },
        ];
        bridge.handler = request => {
            const body = JSON.parse(request.payload) as { changes: StoreChange[] };
            return payload(
                Object.fromEntries(
                    body.changes.map(change => [change.namespace, { revision: 1, entries: change.puts }]),
                ),
            );
        };
        const ack = await records.commit(changes);
        expect(bridge.requests).toHaveLength(1);
        expect(JSON.parse(bridge.requests[0].payload).changes).toEqual(changes);
        expect(ack[offline('a')].entries[shared]).toBe('[]');
        expect(ack[offline('a-masc')].entries[shared]).toBe('[]');
    });

    it('keeps the captured request, including record unicode, after the caller mutates it', async () => {
        const bridge = new FakeBridge();
        let release: (response: NativeStorageResponse) => void = () => undefined;
        const hungInit = new Promise<NativeStorageResponse>(resolve => {
            release = resolve;
        });
        bridge.handler = request =>
            request.operation === 'initialize'
                ? hungInit
                : payload({
                      [offline()]: { revision: 1, entries: { 'hrt-weight': '70-剂量-\u0000-😀-\ud800' } },
                  });
        const records = new NativeRecordStore(bridge);
        const starting = records.initialize();
        const puts: Record<string, string> = { 'hrt-weight': '70-剂量-\u0000-😀-\ud800' };
        const removes: string[] = [];
        const change: StoreChange = { namespace: offline(), expectedRevision: 0, puts, removes };
        const committing = records.commit([change]);
        puts['hrt-weight'] = 'mutated';
        puts['hrt-events'] = 'extra';
        removes.push('hrt-weight');
        release(payload({ backend: 'offline' }));
        const ack = await committing;
        await starting;
        expect(JSON.parse(bridge.requests[1].payload)).toEqual({
            changes: [
                {
                    namespace: offline(),
                    expectedRevision: 0,
                    puts: { 'hrt-weight': '70-剂量-\u0000-😀-\ud800' },
                    removes: [],
                },
            ],
        });
        expect(ack[offline()].entries['hrt-weight']).toBe('70-剂量-\u0000-😀-\ud800');
        expect(Object.isFrozen(ack)).toBe(true);
        expect(Object.isFrozen(ack[offline()])).toBe(true);
        expect(Object.isFrozen(ack[offline()].entries)).toBe(true);
    });

    it('freezes read snapshots and reflects puts, removals, and empty dependencies', async () => {
        const { bridge, records } = await initialized();
        const namespace = offline();
        bridge.handler = request =>
            request.operation === 'read'
                ? payload({ revision: 4, entries: { 'hrt-weight': '70', 'hrt-events': '[]' } })
                : payload({
                      [namespace]: { revision: 5, entries: { 'hrt-weight': '71' } },
                      [PREFERENCES_NAMESPACE]: { revision: 2, entries: { 'app-theme': 'dark' } },
                  });
        const read = await records.read(namespace);
        expect(read).toEqual({ revision: 4, entries: { 'hrt-weight': '70', 'hrt-events': '[]' } });
        expect(Object.isFrozen(read.entries)).toBe(true);
        expect(() => {
            (read.entries as Record<string, string>)['hrt-weight'] = 'changed';
        }).toThrow(TypeError);
        const ack = await records.commit([
            { namespace, expectedRevision: 4, puts: { 'hrt-weight': '71' }, removes: ['hrt-events'] },
            { namespace: PREFERENCES_NAMESPACE, expectedRevision: 2, puts: {}, removes: [] },
        ]);
        expect(Object.keys(ack)).toEqual([namespace, PREFERENCES_NAMESPACE]);
        expect(ack[namespace]).toEqual({ revision: 5, entries: { 'hrt-weight': '71' } });
        expect(ack[PREFERENCES_NAMESPACE]).toEqual({ revision: 2, entries: { 'app-theme': 'dark' } });
        expect(bridge.requests.map(request => request.operation)).toEqual(['read', 'commit']);
    });

    it('rejects malformed successes and does not treat an in-band code as stale', async () => {
        const { bridge, records } = await initialized();
        const namespace = offline();
        const responses: NativeStorageResponse[] = [
            { version: 1, payload: '{', extra: true } as NativeStorageResponse,
            { version: 2, payload: '{}' } as unknown as NativeStorageResponse,
            { version: 1, payload: 'not-json' },
            payload({ code: 'STALE_REVISION' }),
            payload({ revision: 0, entries: {}, code: 'STALE_REVISION' }),
            payload({ revision: 0, entries: { 'hrt-weight': 1 } }),
            payload({ revision: -1, entries: {} }),
            payload({ [namespace]: { revision: 0, entries: {} }, extra: { revision: 0, entries: {} } }),
            payload({ [namespace]: { revision: 2, entries: { 'hrt-weight': '70' } } }),
            payload({ [namespace]: { revision: 1, entries: {} } }),
        ];
        for (const response of responses) {
            bridge.handler = () => response;
            const error = await rejection(
                records.read(namespace).catch(async readError => {
                    throw readError;
                }),
            );
            const commitError = await rejection(
                records.commit([{ namespace, expectedRevision: 0, puts: { 'hrt-weight': '70' }, removes: [] }]),
            );
            for (const failure of [error, commitError]) {
                expect(failure).toBeInstanceOf(Error);
                expect(failure).not.toBeInstanceOf(StaleRevisionError);
                expect((failure as Error).message).toBe(NATIVE_STORAGE_UNAVAILABLE);
                expect((failure as Error).message).not.toContain('STALE_REVISION');
            }
        }
    });

    it('admits the device-preferences namespace for native reads and mode commits', async () => {
        const { bridge, records } = await initialized();
        bridge.handler = request => {
            expect(request.operation).toBe('read');
            expect(JSON.parse(request.payload)).toEqual({ namespace: DEVICE_PREFERENCES_NAMESPACE });
            return payload({ revision: 3, entries: { 'hrt-mode': 'transmasc' } });
        };
        expect(await records.read(DEVICE_PREFERENCES_NAMESPACE)).toEqual({
            revision: 3,
            entries: { 'hrt-mode': 'transmasc' },
        });
        const mode = {
            namespace: DEVICE_PREFERENCES_NAMESPACE,
            expectedRevision: 3,
            puts: { 'hrt-mode': 'transfem' },
            removes: [],
        };
        bridge.handler = request => {
            const body = JSON.parse(request.payload) as { changes: StoreChange[] };
            expect(body.changes).toEqual([mode]);
            return payload({ [DEVICE_PREFERENCES_NAMESPACE]: { revision: 4, entries: { 'hrt-mode': 'transfem' } } });
        };
        const ack = await records.commit([mode]);
        expect(ack[DEVICE_PREFERENCES_NAMESPACE]).toEqual({ revision: 4, entries: { 'hrt-mode': 'transfem' } });
    });

    it('rejects invalid device preference keys and values like any other protocol failure', async () => {
        const { bridge, records } = await initialized();
        const invalid: StoreChange[] = [
            {
                namespace: DEVICE_PREFERENCES_NAMESPACE,
                expectedRevision: 0,
                puts: { 'hrt-mode': 'unknown-mode' },
                removes: [],
            },
            {
                namespace: DEVICE_PREFERENCES_NAMESPACE,
                expectedRevision: 0,
                puts: { 'app-theme': 'dark' },
                removes: [],
            },
        ];
        for (const change of invalid) await expect(records.commit([change])).rejects.toThrow();
        expect(bridge.requests.filter(request => request.operation === 'commit')).toHaveLength(0);
        bridge.handler = () => payload({ revision: 1, entries: { 'hrt-mode': 'forged-native-value' } });
        await expect(records.read(DEVICE_PREFERENCES_NAMESPACE)).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        expect(bridge.requests.filter(request => request.operation === 'read')).toHaveLength(1);
    });

    it('maps only an out-of-band STALE_REVISION and drops every other native message', async () => {
        const { bridge, records } = await initialized();
        const change = weight();
        bridge.handler = () => Promise.reject({ code: 'STALE_REVISION', message: 'leak-marker record text' });
        const stale = await rejection(records.commit([change]));
        expect(stale).toBeInstanceOf(StaleRevisionError);
        expect((stale as Error).message).toBe('Records changed; refresh and review the operation again.');
        expect((stale as Error).message).not.toContain('leak-marker');
        bridge.handler = () => Promise.reject({ code: 'IO', message: 'leak-marker secret' });
        const generic = await rejection(records.commit([change]));
        expect(generic).not.toBeInstanceOf(StaleRevisionError);
        expect((generic as Error).message).toBe(NATIVE_STORAGE_UNAVAILABLE);
        bridge.handler = () => Promise.reject(new Error('STALE_REVISION leak-marker'));
        const unlabeled = await rejection(records.commit([change]));
        expect(unlabeled).not.toBeInstanceOf(StaleRevisionError);
        expect((unlabeled as Error).message).toBe(NATIVE_STORAGE_UNAVAILABLE);
        expect(bridge.requests.filter(request => request.operation === 'commit')).toHaveLength(3);
    });

    it('dedupes initialize, retries after failure, and lets a read wait for it', async () => {
        const bridge = new FakeBridge();
        let release: (response: NativeStorageResponse) => void = () => undefined;
        const hungInit = new Promise<NativeStorageResponse>(resolve => {
            release = resolve;
        });
        let mode: 'hang' | 'fail' | 'ok' = 'hang';
        bridge.handler = request => {
            if (request.operation === 'initialize') {
                if (mode === 'fail') return Promise.reject({ code: 'IO', message: 'leak-marker' });
                if (mode === 'ok') return payload({ backend: 'offline' });
                return hungInit;
            }
            expect(request).toMatchObject({
                version: 1,
                operation: 'read',
                payload: JSON.stringify({ namespace: offline() }),
            });
            return payload({ revision: 0, entries: {} });
        };
        const records = new NativeRecordStore(bridge);
        const first = records.initialize();
        const second = records.initialize();
        const read = records.read(offline());
        expect(bridge.requests).toHaveLength(1);
        release(payload({ backend: 'web' }));
        await expect(first).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        await expect(second).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        await expect(read).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        mode = 'fail';
        await expect(records.initialize()).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        mode = 'ok';
        await records.initialize();
        await records.initialize();
        expect(await records.read(offline())).toEqual({ revision: 0, entries: {} });
        expect(bridge.requests.filter(request => request.operation === 'initialize')).toHaveLength(3);
    });

    it('rejects a hung initialize after the bounded timeout and then retries', async () => {
        vi.useFakeTimers();
        const clear = vi.spyOn(globalThis, 'clearTimeout');
        const bridge = new FakeBridge();
        let hung = true;
        bridge.handler = () =>
            hung ? new Promise<NativeStorageResponse>(() => undefined) : payload({ backend: 'offline' });
        const records = new NativeRecordStore(bridge);
        const pending = records.initialize();
        const failed = expect(pending).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        await vi.advanceTimersByTimeAsync(NATIVE_INITIALIZE_TIMEOUT_MS);
        await failed;
        expect(clear).toHaveBeenCalled();
        hung = false;
        await records.initialize();
        expect(bridge.requests).toHaveLength(2);
    });

    it('does not time out or replay a commit', async () => {
        vi.useFakeTimers();
        const bridge = new FakeBridge();
        let release: (response: NativeStorageResponse) => void = () => undefined;
        bridge.handler = request =>
            request.operation === 'initialize'
                ? payload({ backend: 'offline' })
                : new Promise(resolve => {
                      release = resolve;
                  });
        const records = new NativeRecordStore(bridge);
        await records.initialize();
        let settled = false;
        const committing = records.commit([weight()]);
        void committing.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await vi.advanceTimersByTimeAsync(NATIVE_INITIALIZE_TIMEOUT_MS);
        expect(settled).toBe(false);
        expect(bridge.requests.filter(request => request.operation === 'commit')).toHaveLength(1);
        release(payload({ [offline()]: { revision: 1, entries: { 'hrt-weight': '70' } } }));
        await expect(committing).resolves.toMatchObject({ [offline()]: { revision: 1 } });
        expect(bridge.requests.filter(request => request.operation === 'commit')).toHaveLength(1);
    });

    it('rejects malformed secret text, including a terminal lone surrogate, before transport', async () => {
        const { bridge, secrets } = await initialized();
        for (const key of ['', '\ud800', 'ok\ud800', '\udc00']) {
            await expect(secrets.get(key)).rejects.toThrow('Invalid secret key');
            await expect(secrets.set(key, 'value')).rejects.toThrow('Invalid secret key');
            await expect(secrets.remove(key)).rejects.toThrow('Invalid secret key');
        }
        await expect(secrets.set('key', '\ud800')).rejects.toThrow('Invalid secret value');
        await expect(secrets.set('key', 'tail\ud800')).rejects.toThrow('Invalid secret value');
        expect(bridge.requests).toEqual([]);
        bridge.handler = request => {
            const body = JSON.parse(request.payload) as { key: string; value?: string };
            if (request.operation === 'getSecret') return payload({ value: body.key === 'missing' ? null : '值-😀' });
            return payload({});
        };
        await secrets.set('密钥', '值-😀');
        await secrets.set('empty', '');
        expect(await secrets.get('密钥')).toBe('值-😀');
        expect(await secrets.get('missing')).toBeNull();
        await secrets.remove('密钥');
        bridge.handler = () => payload({ value: 'x', extra: true });
        await expect(secrets.get('密钥')).rejects.toThrow(NATIVE_STORAGE_UNAVAILABLE);
        bridge.handler = () => Promise.reject({ code: 'IO', message: 'leak-marker' });
        const error = await rejection(secrets.remove('密钥'));
        expect((error as Error).message).toBe(NATIVE_STORAGE_UNAVAILABLE);
        expect((error as Error).message).not.toContain('leak-marker');
    });

    it('selects the Android plugin only when the native host exposes it', () => {
        const register = vi.spyOn(capacitor, 'registerPlugin');
        expect(() => createNativeStores()).toThrow(NATIVE_STORAGE_UNAVAILABLE);
        expect(register).not.toHaveBeenCalled();
        vi.spyOn(capacitor.Capacitor, 'isNativePlatform').mockReturnValue(true);
        vi.spyOn(capacitor.Capacitor, 'getPlatform').mockReturnValue('ios');
        expect(() => createNativeStores()).toThrow(NATIVE_STORAGE_UNAVAILABLE);
        vi.spyOn(capacitor.Capacitor, 'getPlatform').mockReturnValue('android');
        vi.spyOn(capacitor.Capacitor, 'isPluginAvailable').mockReturnValue(false);
        expect(() => createNativeStores()).toThrow(NATIVE_STORAGE_UNAVAILABLE);
        expect(register).not.toHaveBeenCalled();
        const execute = vi.fn(async () => payload({ backend: 'offline' }));
        register.mockReturnValue({ execute });
        vi.spyOn(capacitor.Capacitor, 'isPluginAvailable').mockImplementation(name => name === NATIVE_STORAGE_PLUGIN);
        const stores = createNativeStores();
        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith(NATIVE_STORAGE_PLUGIN);
        expect(stores.records).toBeInstanceOf(NativeRecordStore);
        expect(stores.secrets).toBeInstanceOf(NativeSecretStore);
        return stores.records.initialize().then(() => {
            expect(execute).toHaveBeenCalledWith({
                version: 1,
                operation: 'initialize',
                payload: '{}',
            });
        });
    });
});
