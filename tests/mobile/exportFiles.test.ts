import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ester, Route, type DoseEvent, type LabResult } from '../../logic';
import type { FileSavePort, FileSaveRequest, FileSaveResult } from '../../src/platform/contracts/files';
import { exportToPDF } from '../../src/services/export';

const GENERATED_AT = new Date('2026-01-02T12:00:00.000Z');

const events: DoseEvent[] = [
    {
        id: 'synthetic-dose',
        route: Route.injection,
        ester: Ester.EV,
        timeH: Date.parse('2026-01-01T08:00:00.000Z') / 3600000,
        doseMG: 1.25,
        extras: {},
    },
];

const labResults: LabResult[] = [
    {
        id: 'synthetic-lab',
        timeH: Date.parse('2026-01-01T09:00:00.000Z') / 3600000,
        concValue: 95,
        unit: 'pg/ml',
    },
];

const data = {
    events,
    labResults,
    weight: 72,
    lang: 'en' as const,
    t: (key: string) => key,
};

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Readable PDF text, including Flate streams. Ignores document IDs and timestamps. */
function pdfText(bytes: Uint8Array): string {
    const raw = Buffer.from(bytes);
    const latin1 = raw.toString('latin1');
    const parts = [latin1];
    const marker = /stream\r?\n/g;
    for (let match = marker.exec(latin1); match; match = marker.exec(latin1)) {
        const start = match.index + match[0].length;
        const end = latin1.indexOf('endstream', start);
        if (end < 0) break;
        let body = raw.subarray(start, end);
        if (body[body.length - 1] === 0x0a) body = body.subarray(0, -1);
        if (body[body.length - 1] === 0x0d) body = body.subarray(0, -1);
        try {
            parts.push(inflateSync(body).toString('latin1'));
        } catch {
            // Not a Flate stream.
        }
    }
    return parts.join('\n');
}

function portControlled(result: Promise<FileSaveResult>) {
    let request: FileSaveRequest | undefined;
    const files: FileSavePort = {
        save(next) {
            request = next;
            return result;
        },
    };
    return {
        files,
        request: () => request,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('exportToPDF save port', () => {
    it('writes real PDF bytes and stays pending until the port settles', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(GENERATED_AT);
        const gate = deferred<FileSaveResult>();
        const delivered = portControlled(gate.promise);
        let settled = false;
        const pending = exportToPDF(data, delivered.files);
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        const request = delivered.request();
        expect(request).toBeDefined();
        expect(request?.name).toBe('hrt-report-2026-01-02.pdf');
        expect(request?.mimeType).toBe('application/pdf');
        expect(Buffer.from(request!.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        const text = pdfText(request!.bytes);
        expect(text).toContain('Dose history');
        expect(text).toContain('1.25 mg');
        expect(text).toContain('Lab results');
        expect(text).toContain('95 pg/ml');
        expect(text).not.toContain('synthetic-dose');

        gate.resolve('saved');
        await expect(pending).resolves.toBe('saved');
        expect(settled).toBe(true);
    });

    it('returns cancellation from the save port', async () => {
        const delivered = portControlled(Promise.resolve('cancelled'));
        await expect(exportToPDF(data, delivered.files)).resolves.toBe('cancelled');
        expect(delivered.request()?.mimeType).toBe('application/pdf');
    });

    it('propagates save rejection', async () => {
        const failure = new Error('synthetic-save-failure');
        const delivered = portControlled(Promise.reject(failure));
        await expect(exportToPDF(data, delivered.files)).rejects.toBe(failure);
    });
});
