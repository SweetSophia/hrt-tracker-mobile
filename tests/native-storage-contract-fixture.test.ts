import { describe, expect, it } from 'vitest';
import fixture from './fixtures/mobile/storage/record-store-contract-v1.json';
import { allowedKeys, validateChange } from '../src/records/scope';
import { WebRecordStore } from '../src/platform/web/recordStore';

const newStore = () => {
    const values = new Map<string, string>();
    return new WebRecordStore(
        {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => {
                values.set(key, value);
            },
            removeItem: key => {
                values.delete(key);
            },
        },
        fixture.backend,
    );
};

describe('shared native/web record contract fixture', () => {
    it('covers every supported key and preserves canonical scope strings', async () => {
        expect(fixture.version).toBe(1);
        const store = newStore();
        await store.initialize();
        for (const item of fixture.valid) {
            expect(new Set(item.keys)).toEqual(allowedKeys(item.namespace));
            const entries = Object.fromEntries(item.keys.map(key => [key, 'unicode-😀-\ud800-\u0000']));
            const change = { namespace: item.namespace, expectedRevision: 0, puts: entries, removes: [] };
            expect(() => validateChange(change)).not.toThrow();
            await store.commit([change]);
            expect((await store.read(item.namespace)).entries).toEqual(entries);
        }
    });

    it('rejects foreign/noncanonical scopes and credentials before mutation', async () => {
        const store = newStore();
        await store.initialize();
        for (const item of fixture.invalid) {
            if (!item.keys.length) await expect(store.read(item.namespace)).rejects.toThrow();
            for (const key of item.keys) {
                const change = {
                    namespace: item.namespace,
                    expectedRevision: 0,
                    puts: { [key]: 'synthetic' },
                    removes: [],
                };
                expect(() => validateChange(change)).toThrow();
                await expect(store.commit([change])).rejects.toThrow();
            }
        }
        for (const item of fixture.valid) expect((await store.read(item.namespace)).entries).toEqual({});
    });
});
