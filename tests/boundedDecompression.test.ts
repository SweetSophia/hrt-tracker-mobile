import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decompressGzipWithLimit } from '../src/services/boundedDecompression';

const gzip = (text: string): Uint8Array => new Uint8Array(gzipSync(Buffer.from(text)));

describe('bounded gzip decompression', () => {
    it('returns the output when it is exactly at the limit', async () => {
        const output = await decompressGzipWithLimit(gzip('hello'), 5);
        expect(new TextDecoder().decode(output)).toBe('hello');
    });

    it('rejects the first byte over the limit', async () => {
        await expect(decompressGzipWithLimit(gzip('hello'), 4)).rejects.toThrow('decompressed output is too large');
    });

    it('applies the limit to the total output of concatenated gzip members', async () => {
        const input = new Uint8Array([...gzip('AAA'), ...gzip('BBB')]);
        // The ceiling counts every decompressed byte across the whole stream,
        // so a limit below even the first member's output must reject. This is
        // platform-independent: the limiter errors before any end-of-stream
        // handling can matter.
        await expect(decompressGzipWithLimit(input, 2)).rejects.toThrow('decompressed output is too large');
        // Platforms disagree on a second gzip member. The WHATWG Compression
        // Streams spec ("throw a TypeError if the end of the compressed input
        // has not been reached") and every browser engine treat it as trailing
        // input (Chrome: "Junk found after end of compressed data."). Node's
        // DecompressionStream historically decoded members like zlib does
        // (nodejs/node#58247) and aligned with the spec in v26
        // (ERR_TRAILING_JUNK_AFTER_STREAM_END; plain zlib APIs still decode
        // members). CI pins Node 22, which still decodes them. Probe the
        // platform capability through a bare DecompressionStream — never the
        // wrapper under test — so a wrapper regression cannot demote itself
        // into the rejection branch and skip the assertions that catch it.
        const platformDecodesMembers = await new Response(
            new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
        )
            .arrayBuffer()
            .then(
                buffer => new TextDecoder().decode(buffer) === 'AAABBB',
                () => false,
            );
        if (platformDecodesMembers) {
            await expect(decompressGzipWithLimit(input, 5)).rejects.toThrow('decompressed output is too large');
            expect(new TextDecoder().decode(await decompressGzipWithLimit(input, 6))).toBe('AAABBB');
        } else {
            await expect(decompressGzipWithLimit(input, 5)).rejects.toThrow();
            await expect(decompressGzipWithLimit(input, 6)).rejects.toThrow();
        }
    });

    it('accepts a high-ratio payload that stays under the absolute limit by design', async () => {
        // This is the residual documented in the review: the defence is a
        // byte ceiling, not a compression-ratio ceiling. A viewer that keeps
        // reopening a live link must be stopped at the polling layer.
        const input = new Uint8Array(gzipSync(Buffer.alloc(4 * 1024 * 1024)));
        expect((4 * 1024 * 1024) / input.byteLength).toBeGreaterThan(1000);
        const output = await decompressGzipWithLimit(input, 8 * 1024 * 1024);
        expect(output.byteLength).toBe(4 * 1024 * 1024);
    });
});
