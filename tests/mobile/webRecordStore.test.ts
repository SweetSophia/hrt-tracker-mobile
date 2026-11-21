import { describe, expect, it } from 'vitest';
import { WebRecordStore } from '../../src/platform/web/recordStore';
import { StaleRevisionError, type StoreChange } from '../../src/platform/contracts';
import { PREFERENCES_NAMESPACE, recordNamespace } from '../../src/records/scope';
import { journalChecksum, REPLACE_JOURNAL_KEY } from '../../src/utils/replaceJournal';

class Storage {
    data = new Map<string, string>();
    fail?: (key: string, value: string | null) => boolean;
    getItem(key: string) {
        return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        if (this.fail?.(key, value)) throw new Error('disk full');
        this.data.set(key, value);
    }
    removeItem(key: string) {
        if (this.fail?.(key, null)) throw new Error('disk full');
        this.data.delete(key);
    }
}
const namespace = (owner = 'local', backend = 'web') => recordNamespace({ backend, owner, mode: 'transfem' });
const setup = async (storage = new Storage()) => {
    const store = new WebRecordStore(storage, 'web');
    await store.initialize();
    return { store, storage };
};
const change = (revision = 0, puts: Record<string, string> = { 'hrt-weight': '71' }): StoreChange => ({
    namespace: namespace(),
    expectedRevision: revision,
    puts,
    removes: [],
});

describe('browser RecordStore', () => {
    it('requires initialization and reads missing namespaces without defaults', async () => {
        const storage = new Storage();
        const store = new WebRecordStore(storage, 'web');
        await expect(store.read(namespace())).rejects.toThrow();
        await Promise.all([store.initialize(), store.initialize()]);
        expect(await store.read(namespace())).toEqual({ revision: 0, entries: {} });
        expect(await store.read(PREFERENCES_NAMESPACE)).toEqual({ revision: 0, entries: {} });
        expect(storage.data.size).toBe(0);
    });
    it('persists revisions and existing keys across adapters without leaking metadata', async () => {
        const { store, storage } = await setup();
        const committed = await store.commit([change()]);
        expect(committed[namespace()]).toEqual({ revision: 1, entries: { 'hrt-weight': '71' } });
        const reopened = (await setup(storage)).store;
        expect(await reopened.read(namespace())).toEqual(committed[namespace()]);
        expect(storage.getItem('hrt-weight')).toBe('71');
        const unchanged = await reopened.commit([change(1, {})]);
        expect(unchanged[namespace()].revision).toBe(1);
    });
    it('checks the entire read set before any write and rejects stale callers', async () => {
        const { store, storage } = await setup();
        await store.commit([change()]);
        const before = new Map(storage.data);
        await expect(
            store.commit([
                change(1, { 'hrt-weight': '72' }),
                {
                    namespace: PREFERENCES_NAMESPACE,
                    expectedRevision: 1,
                    puts: { 'app-theme': 'dark' },
                    removes: [],
                },
            ]),
        ).rejects.toBeInstanceOf(StaleRevisionError);
        expect(storage.data).toEqual(before);
    });
    it('detects another tab and uncoordinated legacy changes', async () => {
        const { store, storage } = await setup();
        await store.commit([change()]);
        const other = (await setup(storage)).store;
        await other.commit([change(1, { 'hrt-weight': '72' })]);
        await expect(store.commit([change(1)])).rejects.toBeInstanceOf(StaleRevisionError);
        storage.setItem('hrt-weight', '73');
        await expect(other.commit([change(2)])).rejects.toBeInstanceOf(StaleRevisionError);
        const refreshed = await other.read(namespace());
        expect(refreshed.revision).toBe(3);
        expect(refreshed.entries['hrt-weight']).toBe('73');
        expect((await (await setup(storage)).store.read(namespace())).revision).toBe(3);
    });
    it('rejects credentials, foreign backends, duplicate namespaces and overlapping keys', async () => {
        const { store, storage } = await setup();
        for (const changes of [
            [change(0, { auth_token: 'synthetic' })],
            [{ ...change(), namespace: namespace('local', 'other') }],
            [change(), change()],
            [{ ...change(), removes: ['hrt-weight'] }],
        ])
            await expect(store.commit(changes)).rejects.toThrow();
        expect(storage.data.size).toBe(0);
    });
    it('rolls records and preferences back together when a later write fails', async () => {
        const { store, storage } = await setup();
        storage.fail = key => key === 'app-theme';
        await expect(
            store.commit([
                change(),
                {
                    namespace: PREFERENCES_NAMESPACE,
                    expectedRevision: 0,
                    puts: { 'app-theme': 'dark' },
                    removes: [],
                },
            ]),
        ).rejects.toThrow();
        storage.fail = undefined;
        expect(await store.read(namespace())).toEqual({ revision: 0, entries: {} });
        expect(await store.read(PREFERENCES_NAMESPACE)).toEqual({ revision: 0, entries: {} });
        expect((await store.commit([change()]))[namespace()].revision).toBe(1);
    });
    it('recovers interrupted writes before returning any records and blocks corrupt journals', async () => {
        const storage = new Storage();
        const writes = [{ key: 'hrt-weight', value: '80' }];
        const snapshot = [{ key: 'hrt-weight', value: '70' }];
        storage.setItem('hrt-weight', '80');
        storage.setItem(
            REPLACE_JOURNAL_KEY,
            JSON.stringify({
                v: 1,
                phase: 'applying',
                createdAt: 1,
                owner: 'local',
                writes,
                snapshot,
                checksum: journalChecksum(writes, snapshot),
            }),
        );
        const { store } = await setup(storage);
        expect((await store.read(namespace())).entries['hrt-weight']).toBe('70');
        storage.setItem(REPLACE_JOURNAL_KEY, '{bad');
        await expect(store.read(namespace())).rejects.toThrow();
        await expect(store.commit([change(1)])).rejects.toThrow();
        expect(storage.getItem('hrt-weight')).toBe('70');
    });
    it('keeps both signed-out modes and legacy CPA out of a newly opened account', async () => {
        const storage = new Storage();
        storage.setItem('hrt-events', '[]');
        storage.setItem('hrt-masc-events', '[{"id":"synthetic"}]');
        storage.setItem('hrt-cpa-plan', 'legacy');
        storage.setItem('app-age-beta', 'true');
        storage.setItem('auth_token', 'synthetic');
        const { store } = await setup(storage);
        const account = await store.read(namespace('42'));
        expect(account.entries).toEqual({ 'hrt-u42-age-beta': 'true' });
        expect(storage.getItem('hrt-events')).toBe('[]');
        expect(storage.getItem('hrt-masc-events')).toBe('[{"id":"synthetic"}]');
        expect(storage.getItem('hrt-cpa-plan')).toBe('legacy');
        expect(storage.getItem('auth_token')).toBe('synthetic');
        expect((await store.read(namespace('43'))).entries['hrt-u43-events']).toBeUndefined();
    });
    it('keeps an existing account intact and does not move local records into it', async () => {
        const storage = new Storage();
        storage.setItem('hrt-weight', '70');
        storage.setItem('hrt-u42-weight', '80');
        const { store } = await setup(storage);
        expect((await store.read(namespace('42'))).entries['hrt-u42-weight']).toBe('80');
        expect(storage.getItem('hrt-weight')).toBe('70');
    });
    it('preserves signed-out records when an account preference migration fails', async () => {
        const storage = new Storage();
        storage.setItem('hrt-weight', '70');
        storage.setItem('app-age-beta', 'true');
        storage.fail = (key, value) => key === 'hrt-u42-age-beta' && value !== null;
        const { store } = await setup(storage);
        await expect(store.read(namespace('42'))).rejects.toThrow();
        expect(storage.getItem('hrt-weight')).toBe('70');
        expect(storage.getItem('hrt-u42-age-beta')).toBeNull();
    });
});
