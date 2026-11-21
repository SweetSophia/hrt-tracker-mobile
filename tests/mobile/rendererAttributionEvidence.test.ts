import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { verifyRendererRunReport, verifyRendererTrace } from '../../scripts/mobile/map-renderer-frames.mjs';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const trace = { complete: true, traceEvents: [] };
const raw = Buffer.from(JSON.stringify(trace));
const archived = gzipSync(raw);
const evidence = {
    compressedTrace: { sha256: digest(archived), uncompressedSha256: digest(raw) },
    rawTrace: { sha256: digest(raw) },
};

it('returns the verified raw digest and rejects either conflicting raw trace pin', () => {
    expect(verifyRendererTrace(archived, evidence)).toEqual({ capture: trace, rawTraceSha256: digest(raw) });
    expect(() => verifyRendererTrace(archived, { ...evidence, rawTrace: { sha256: '0'.repeat(64) } })).toThrow(
        'Raw trace hash differs',
    );
    expect(() =>
        verifyRendererTrace(archived, {
            ...evidence,
            compressedTrace: { ...evidence.compressedTrace, uncompressedSha256: '0'.repeat(64) },
        }),
    ).toThrow('Raw trace hash differs');
});

it('rejects matching raw trace pins when both differ from the actual bytes', () => {
    const wrong = '0'.repeat(64);
    expect(() =>
        verifyRendererTrace(archived, {
            compressedTrace: { ...evidence.compressedTrace, uncompressedSha256: wrong },
            rawTrace: { sha256: wrong },
        }),
    ).toThrow('Raw trace hash differs');
});

it('verifies the embedded reports against the original run output before using the device labels', () => {
    const runs = JSON.parse(
        readFileSync(new URL('../fixtures/mobile/renderer-profiled-runs.json', import.meta.url), 'utf8'),
    );
    for (const { report, pin } of runs) {
        expect(() => verifyRendererRunReport(report, pin)).not.toThrow();
        expect(() => verifyRendererRunReport({ ...report, api: 99 }, pin)).toThrow('Run report hash differs');
        expect(() => verifyRendererRunReport({ ...report, pageSize: 32768 }, pin)).toThrow('Run report hash differs');
    }
});
