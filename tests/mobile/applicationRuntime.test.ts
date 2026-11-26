import { expect, it, vi } from 'vitest';
import { createWebRuntime } from '../../src/application/runtime';
import { planCompleteBackup, planRecordOperation } from '../../src/records';
import { recordNamespace } from '../../src/records/scope';

class MemoryStorage implements Storage {
    data = new Map<string, string>();
    get length() {
        return this.data.size;
    }
    key(index: number) {
        return [...this.data.keys()][index] ?? null;
    }
    clear() {
        this.data.clear();
    }
    getItem = vi.fn((key: string) => this.data.get(key) ?? null);
    setItem = vi.fn((key: string, value: string) => {
        this.data.set(key, value);
    });
    removeItem(key: string) {
        this.data.delete(key);
    }
}
it('does not read storage or expose a runtime before initialization acquires its lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => {
        release = done;
    });
    const storage = new MemoryStorage();
    const locks = {
        request: async (_name: string, operation: () => unknown) => {
            await gate;
            return operation();
        },
    } as LockManager;
    const opening = createWebRuntime(storage, 'web', locks);
    await Promise.resolve();
    expect(storage.getItem).not.toHaveBeenCalled();
    release();
    const runtime = await opening;
    expect(runtime.controller.getState().status).toBe('ready');
    expect(storage.setItem).not.toHaveBeenCalled();
});
it('keeps failed portable and device preference writes out of published state', async () => {
    const storage = new MemoryStorage();
    const runtime = await createWebRuntime(storage, 'web');
    storage.setItem.mockImplementation(() => {
        throw new Error('synthetic quota');
    });
    expect(await runtime.setPreference('app-theme', 'dark')).toBe(false);
    expect(runtime.getState().preferences['app-theme']).toBeUndefined();
    expect(runtime.setDevice('hrt-mode', 'transmasc')).toBe(false);
    expect(runtime.getState().device['hrt-mode']).toBeUndefined();
    expect(runtime.getState().error).toBeInstanceOf(Error);
    expect(() => runtime.setDevice('auth_token' as 'hrt-mode', 'synthetic')).toThrow('Unknown');
});
it('publishes complete-restore preferences from the same acknowledged snapshot as records', async () => {
    const storage = new MemoryStorage();
    const runtime = await createWebRuntime(storage, 'web');
    const seen: unknown[] = [];
    runtime.subscribe(() => {
        const state = runtime.controller.getState();
        if (state.status === 'ready')
            seen.push([
                runtime.getState().preferences['app-theme'],
                state.snapshots[recordNamespace(state.scope)].entries['hrt-weight'],
            ]);
    });
    const raw = {
        format: 'oyama-hrt-complete-backup',
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        mode: 'transfem',
        modes: { transfem: {}, transmasc: {} },
        weight: 72,
        preferences: { 'app-theme': 'dark', 'app-palette': 'plum' },
    };
    await runtime.controller.dispatch(context => planCompleteBackup(context, raw, 'merge', Date.now()));
    expect(seen).toEqual([['dark', '72']]);
    expect(storage.getItem('app-theme')).toBe('dark');
    expect(storage.getItem('app-palette')).toBe('plum');
});
it('retains only the onboarding presence flag from other accounts and excludes credentials', async () => {
    const storage = new MemoryStorage();
    storage.data.set('hrt-u42-events', '[{"id":"synthetic"}]');
    storage.data.set('auth_token', 'synthetic');
    const runtime = await createWebRuntime(storage, 'web');
    expect(runtime.hasPriorRecords).toBe(true);
    expect(JSON.stringify(runtime.getState())).not.toContain('synthetic');
});

it('clears the confirmed account after admitted writes, and fences later edits away from it', async () => {
    const storage = new MemoryStorage();
    storage.data.set('hrt-weight', '62');
    storage.data.set('hrt-u42-masc-events', '[]');
    storage.data.set('hrt-u42-cpa-plan', 'legacy');
    storage.data.set('hrt-u43-weight', '80');
    const runtime = await createWebRuntime(storage, 'web');
    await runtime.controller.activate({ backend: 'web', owner: '42', mode: 'transfem' });
    await expect(runtime.clearSignedInRecords('43')).rejects.toThrow('Record scope changed');
    const pending = runtime.controller.dispatch(context =>
        planRecordOperation(context, store => store.setItem('hrt-u42-weight', '72')),
    );
    const clearing = runtime.clearSignedInRecords('42');
    await expect(
        runtime.controller.dispatch(() => {
            throw new Error('Late edit');
        }),
    ).rejects.toThrow('not ready');
    await pending;
    await clearing;
    expect(storage.getItem('hrt-u42-weight')).toBeNull();
    expect(storage.getItem('hrt-u42-masc-events')).toBeNull();
    expect(storage.getItem('hrt-u42-cpa-plan')).toBeNull();
    expect(storage.getItem('hrt-u43-weight')).toBe('80');
    expect(storage.getItem('hrt-weight')).toBe('62');
});
