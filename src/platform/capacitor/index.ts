import { Capacitor, registerPlugin } from '@capacitor/core';
import type { RecordStore, SecretStore } from '../contracts';
import {
    NATIVE_STORAGE_PLUGIN,
    nativeStorageUnavailable,
    type NativeStorageBridge,
    type NativeStorageRequest,
    type NativeStorageResponse,
} from './bridge';
import { NativeRecordStore } from './recordStore';
import { NativeSecretStore } from './secretStore';

interface HrtNativeStoragePlugin {
    execute(request: NativeStorageRequest): Promise<NativeStorageResponse>;
}

export function createNativeStores(): { records: RecordStore; secrets: SecretStore } {
    if (
        !Capacitor.isNativePlatform() ||
        Capacitor.getPlatform() !== 'android' ||
        !Capacitor.isPluginAvailable(NATIVE_STORAGE_PLUGIN)
    ) {
        throw nativeStorageUnavailable();
    }
    const plugin = registerPlugin<HrtNativeStoragePlugin>(NATIVE_STORAGE_PLUGIN);
    const bridge: NativeStorageBridge = {
        execute: request => plugin.execute(request),
    };
    return { records: new NativeRecordStore(bridge), secrets: new NativeSecretStore(bridge) };
}

export { NativeRecordStore, NativeSecretStore };
export type { NativeStorageBridge, NativeStorageRequest, NativeStorageResponse };
