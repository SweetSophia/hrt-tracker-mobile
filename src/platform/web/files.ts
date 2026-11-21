import { DocumentTooLargeError, MAX_DOCUMENT_BYTES, type FilePickPort, type FilePickResult } from '../contracts/files';
import type { FileSavePort, FileSaveRequest, FileSaveResult } from '../contracts/files';

/** Browser delivery cannot observe a completed disk write, so success means the download was requested. */
export class WebFileSavePort implements FileSavePort {
    async save(request: FileSaveRequest): Promise<FileSaveResult> {
        const bytes = new Uint8Array(request.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: request.mimeType }));
        let anchor: HTMLAnchorElement | undefined;
        try {
            anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = request.name;
            document.body.appendChild(anchor);
            anchor.click();
        } catch (error) {
            anchor?.remove();
            URL.revokeObjectURL(url);
            throw error;
        }
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'download-requested';
    }
}

/** Check metadata before opening, then enforce the bound even if metadata lies. */
export async function readDocumentFile(file: File): Promise<FilePickResult> {
    if (file.size > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
    const reader = file.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { name: file.name, mimeType: file.type, bytes };
}

export class WebFilePickPort implements FilePickPort {
    private pending = false;
    async pick(): Promise<FilePickResult | null> {
        if (this.pending) throw new Error('Document picker is already open.');
        this.pending = true;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.hidden = true;
        try {
            const file = await new Promise<File | null>((resolve, reject) => {
                input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
                input.addEventListener('cancel', () => resolve(null), { once: true });
                document.body.appendChild(input);
                try {
                    input.click();
                } catch (error) {
                    reject(error);
                }
            });
            return file ? await readDocumentFile(file) : null;
        } finally {
            input.remove();
            this.pending = false;
        }
    }
}
