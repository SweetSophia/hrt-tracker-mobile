import type { SecretStore } from '../contracts';
import { invokeNative, isRecord, nativeStorageUnavailable, type NativeStorageBridge } from './bridge';

function isWellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0xd800 || code > 0xdfff) continue;
        const next = value.charCodeAt(index + 1);
        // charCodeAt past the end is NaN, and both NaN comparisons are false.
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            index += 1;
            continue;
        }
        return false;
    }
    return true;
}

function assertSecretKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0 || !isWellFormedUnicode(key)) throw new Error('Invalid secret key');
}

function assertSecretValue(value: string): void {
    if (typeof value !== 'string' || !isWellFormedUnicode(value)) throw new Error('Invalid secret value');
}

function assertEmpty(raw: unknown): void {
    if (!isRecord(raw) || Object.keys(raw).length !== 0) throw nativeStorageUnavailable();
}

export class NativeSecretStore implements SecretStore {
    constructor(private readonly bridge: NativeStorageBridge) {}

    async get(key: string): Promise<string | null> {
        assertSecretKey(key);
        const raw = await invokeNative(this.bridge, 'getSecret', { key });
        if (!isRecord(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'value'))
            throw nativeStorageUnavailable();
        if (raw.value === null) return null;
        if (typeof raw.value !== 'string' || !isWellFormedUnicode(raw.value)) throw nativeStorageUnavailable();
        return raw.value;
    }

    async set(key: string, value: string): Promise<void> {
        assertSecretKey(key);
        assertSecretValue(value);
        assertEmpty(await invokeNative(this.bridge, 'setSecret', { key, value }));
    }

    async remove(key: string): Promise<void> {
        assertSecretKey(key);
        assertEmpty(await invokeNative(this.bridge, 'removeSecret', { key }));
    }
}
