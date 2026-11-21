import { Capacitor, registerPlugin } from '@capacitor/core';
import {
    DocumentTooLargeError,
    MAX_DOCUMENT_BYTES,
    type FilePickPort,
    type FilePickResult,
    type FileSavePort,
    type FileSaveRequest,
    type FileSaveResult,
} from '../contracts/files';

export const NATIVE_DOCUMENTS_PLUGIN = 'HrtNativeDocuments';
export interface NativeDocumentBridge {
    pick(request: { version: number }): Promise<unknown>;
    save(request: { version: number; name: string; mimeType: string; base64: string }): Promise<unknown>;
}
const failed = () => new Error('Document operation failed.');
const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
};
const response = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) throw failed();
    return value as Record<string, unknown>;
};
const translateError = (error: unknown): never => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'DOCUMENT_TOO_LARGE')
        throw new DocumentTooLargeError();
    throw failed();
};

/** Byte transport only: no backup format, record or credential knowledge. */
export class NativeFiles implements FileSavePort, FilePickPort {
    constructor(private readonly bridge: NativeDocumentBridge) {}
    async save(request: FileSaveRequest): Promise<FileSaveResult> {
        if (request.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
        try {
            const result = response(
                await this.bridge.save({
                    version: 1,
                    name: request.name,
                    mimeType: request.mimeType,
                    base64: encode(request.bytes),
                }),
            );
            if (result.outcome !== 'saved' && result.outcome !== 'cancelled') throw failed();
            return result.outcome;
        } catch (error) {
            return translateError(error);
        }
    }
    async pick(): Promise<FilePickResult | null> {
        try {
            const result = response(await this.bridge.pick({ version: 1 }));
            if (result.outcome === 'cancelled') return null;
            if (
                result.outcome !== 'picked' ||
                typeof result.name !== 'string' ||
                typeof result.mimeType !== 'string' ||
                typeof result.base64 !== 'string'
            )
                throw failed();
            if (result.base64.length > 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3)) throw new DocumentTooLargeError();
            const binary = atob(result.base64);
            if (binary.length > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
            if (btoa(binary) !== result.base64) throw failed();
            return {
                name: result.name,
                mimeType: result.mimeType,
                bytes: Uint8Array.from(binary, c => c.charCodeAt(0)),
            };
        } catch (error) {
            return translateError(error);
        }
    }
}

export function createNativeFiles(): NativeFiles {
    if (
        !Capacitor.isNativePlatform() ||
        Capacitor.getPlatform() !== 'android' ||
        !Capacitor.isPluginAvailable(NATIVE_DOCUMENTS_PLUGIN)
    )
        throw failed();
    return new NativeFiles(registerPlugin<NativeDocumentBridge>(NATIVE_DOCUMENTS_PLUGIN));
}
