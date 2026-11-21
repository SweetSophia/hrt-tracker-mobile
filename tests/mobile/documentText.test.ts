import { describe, expect, it } from 'vitest';
import { decodeDocumentText } from '../../src/utils/decodeDocumentText';

const text = JSON.stringify({ name: 'Café 週末 💜', value: '\u0000' });
const utf16 = (bigEndian: boolean) => {
    const bytes = Buffer.from('\ufeff' + text, 'utf16le');
    return bigEndian ? bytes.swap16() : bytes;
};
describe('document text decoding', () => {
    it.each([
        ['UTF-8', new TextEncoder().encode(text)],
        ['UTF-8 BOM', new TextEncoder().encode('\ufeff' + text)],
        ['UTF-16LE BOM', utf16(false)],
        ['UTF-16BE BOM', utf16(true)],
    ] as const)('preserves Unicode JSON from %s', (_encoding, bytes) => {
        expect(decodeDocumentText(bytes)).toBe(text);
        expect(JSON.parse(decodeDocumentText(bytes))).toEqual(JSON.parse(text));
    });
    it('reads only a byte view, including its own BOM', () => {
        const bytes = utf16(true);
        const padded = new Uint8Array(bytes.length + 4);
        padded.set([255, 254], 0);
        padded.set(bytes, 2);
        expect(decodeDocumentText(padded.subarray(2, bytes.length + 2))).toBe(text);
    });
    it('retains UTF-8 as the default instead of guessing from NUL bytes', () => {
        expect(decodeDocumentText(new Uint8Array([123, 0, 125, 0]))).toBe('{\u0000}\u0000');
    });
    it('preserves empty input and replacement decoding for truncated input', () => {
        expect(decodeDocumentText(new Uint8Array())).toBe('');
        expect(decodeDocumentText(new Uint8Array([0xef, 0xbb]))).toBe('\ufffd');
        expect(decodeDocumentText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe('\ufffd');
    });
});
