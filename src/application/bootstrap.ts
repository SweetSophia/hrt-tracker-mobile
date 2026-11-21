import { createWebRuntime, type ApplicationRuntime } from './runtime';

/** Await the selected store; a native failure must never select an empty web store. */
export async function createApplicationRuntime(
    storage: Storage,
    backend: string,
    locks?: LockManager,
): Promise<ApplicationRuntime> {
    if (typeof __HRT_NATIVE_RECORDS__ !== 'undefined' && __HRT_NATIVE_RECORDS__) {
        const { createNativeRuntime } = await import('./nativeRuntime');
        return createNativeRuntime(storage);
    }
    return createWebRuntime(storage, backend, locks);
}
