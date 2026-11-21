import { StaleRevisionError } from '../contracts';

export const NATIVE_STORAGE_PLUGIN = 'HrtNativeStorage';
export const NATIVE_STORAGE_UNAVAILABLE = 'Native storage is unavailable';
export const NATIVE_INITIALIZE_TIMEOUT_MS = 30_000;

export type NativeStorageOperation = 'initialize' | 'read' | 'commit' | 'getSecret' | 'setSecret' | 'removeSecret';

export interface NativeStorageRequest {
    readonly version: 1;
    readonly operation: NativeStorageOperation;
    readonly payload: string;
}

export interface NativeStorageResponse {
    readonly version: 1;
    readonly payload: string;
}

/** Injectable transport. Production uses the Capacitor plugin; tests supply a fake. */
export interface NativeStorageBridge {
    execute(request: NativeStorageRequest): Promise<NativeStorageResponse>;
}

export function nativeStorageUnavailable(): Error {
    return new Error(NATIVE_STORAGE_UNAVAILABLE);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeCode(error: unknown): string | undefined {
    if (!isRecord(error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

/** Map the native stale code only. Every other failure stays generic and payload-free. */
export function translateNativeError(error: unknown): Error {
    if (error instanceof StaleRevisionError) return error;
    if (nativeCode(error) === 'STALE_REVISION') return new StaleRevisionError();
    return nativeStorageUnavailable();
}

export async function invokeNative(
    bridge: NativeStorageBridge,
    operation: NativeStorageOperation,
    payload: unknown,
): Promise<unknown> {
    const request: NativeStorageRequest = { version: 1, operation, payload: JSON.stringify(payload) };
    let response: NativeStorageResponse;
    try {
        response = await bridge.execute(request);
    } catch (error) {
        throw translateNativeError(error);
    }
    if (
        !isRecord(response) ||
        Object.keys(response).length !== 2 ||
        response.version !== 1 ||
        typeof response.payload !== 'string'
    ) {
        throw nativeStorageUnavailable();
    }
    try {
        return JSON.parse(response.payload);
    } catch {
        throw nativeStorageUnavailable();
    }
}
