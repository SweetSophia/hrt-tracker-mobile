import { describe, expect, it, vi } from 'vitest';
import * as files from '../../src/platform/web/files';
import * as contract from '../../src/platform/contracts/files';

describe('bounded document reads', () => {
    it('exposes the picker and a 16 MiB transport bound', () => {
        expect(files.WebFilePickPort).toBeTypeOf('function');
        expect(contract.MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024);
    });
    it('preserves UTF-8 and binary bytes exactly', async () => {
        const bytes = new Uint8Array([0, 255, 128, 13, 10, ...new TextEncoder().encode('Café 💜')]);
        const result = await files.readDocumentFile(new File([bytes], 'backup.json', { type: 'application/json' }));
        expect(result).toEqual({ name: 'backup.json', mimeType: 'application/json', bytes });
    });
    it('rejects declared oversize before opening the stream', async () => {
        const stream = vi.fn();
        await expect(
            files.readDocumentFile({ size: 16 * 1024 * 1024 + 1, stream } as unknown as File),
        ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
        expect(stream).not.toHaveBeenCalled();
    });
    it('bounds dishonest streams and cancels the reader', async () => {
        const cancel = vi.fn();
        const file = {
            size: 1,
            stream: () =>
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
                        controller.enqueue(new Uint8Array([1]));
                    },
                    cancel,
                }),
        } as unknown as File;
        await expect(files.readDocumentFile(file)).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
        expect(cancel).toHaveBeenCalled();
    });
    it('propagates read failure without returning partial bytes', async () => {
        const file = {
            size: 1,
            stream: () =>
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error('denied'));
                    },
                }),
        } as File;
        await expect(files.readDocumentFile(file)).rejects.toThrow();
    });
});
