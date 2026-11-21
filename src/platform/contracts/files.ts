export interface FileSaveRequest {
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
}

export type FileSaveResult = 'saved' | 'cancelled' | 'download-requested';

export interface FileSavePort {
    save(request: FileSaveRequest): Promise<FileSaveResult>;
}

/** Bounds document transport and base64 bridge memory, independently of decompression limits. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

export class DocumentTooLargeError extends Error {
    readonly code = 'DOCUMENT_TOO_LARGE';
    constructor() {
        super('Document exceeds the size limit.');
    }
}

export interface FilePickResult {
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
}

export interface FilePickPort {
    pick(): Promise<FilePickResult | null>;
}
