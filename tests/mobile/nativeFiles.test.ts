import { describe, expect, it, vi } from 'vitest';
import { NativeFiles } from '../../src/platform/capacitor/files';
import { MAX_DOCUMENT_BYTES } from '../../src/platform/contracts/files';

const bridge = () => ({ pick: vi.fn(), save: vi.fn() });
describe('native document adapter', () => {
    it('copies binary subarray bytes before asynchronous save and validates acknowledgement', async () => {
        const plugin = bridge();
        plugin.save.mockResolvedValue({ version: 1, outcome: 'saved' });
        const source = new Uint8Array([9, 0, 255, 128, 9]);
        const result = new NativeFiles(plugin).save({
            name: 'Café.pdf',
            mimeType: 'application/pdf',
            bytes: source.subarray(1, 4),
        });
        source.fill(1);
        expect(await result).toBe('saved');
        expect(plugin.save).toHaveBeenCalledWith({
            version: 1,
            name: 'Café.pdf',
            mimeType: 'application/pdf',
            base64: 'AP+A',
        });
    });
    it('preserves picked bytes and cancellation', async () => {
        const plugin = bridge();
        plugin.pick
            .mockResolvedValueOnce({
                version: 1,
                outcome: 'picked',
                name: 'backup.json',
                mimeType: 'application/json',
                base64: 'AP+A',
            })
            .mockResolvedValueOnce({ version: 1, outcome: 'cancelled' });
        const port = new NativeFiles(plugin);
        expect(await port.pick()).toEqual({
            name: 'backup.json',
            mimeType: 'application/json',
            bytes: new Uint8Array([0, 255, 128]),
        });
        expect(await port.pick()).toBeNull();
        plugin.save.mockResolvedValue({ version: 1, outcome: 'cancelled' });
        expect(await port.save({ name: 'x', mimeType: 'application/json', bytes: new Uint8Array() })).toBe('cancelled');
    });
    it.each([{}, { version: 2, outcome: 'saved' }, { version: 1, outcome: 'download-requested' }])(
        'rejects malformed save acknowledgement %j',
        async response => {
            const plugin = bridge();
            plugin.save.mockResolvedValue(response);
            await expect(
                new NativeFiles(plugin).save({ name: 'x', mimeType: 'application/json', bytes: new Uint8Array() }),
            ).rejects.toThrow('Document operation failed.');
        },
    );
    it.each(['!', 'AA', 'AB==', '===='])('rejects noncanonical picked base64 %s', async base64 => {
        const plugin = bridge();
        plugin.pick.mockResolvedValue({
            version: 1,
            outcome: 'picked',
            name: 'x',
            mimeType: 'application/json',
            base64,
        });
        await expect(new NativeFiles(plugin).pick()).rejects.toThrow();
    });
    it('bounds saves before calling the bridge and maps size errors without leaking provider errors', async () => {
        const plugin = bridge();
        const port = new NativeFiles(plugin);
        await expect(
            port.save({ name: 'x', mimeType: 'application/json', bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) }),
        ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
        expect(plugin.save).not.toHaveBeenCalled();
        plugin.pick
            .mockRejectedValueOnce({ code: 'DOCUMENT_TOO_LARGE', message: 'secret path' })
            .mockRejectedValueOnce(new Error('secret path'));
        await expect(port.pick()).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
        await expect(port.pick()).rejects.toThrow('Document operation failed.');
    });
});
