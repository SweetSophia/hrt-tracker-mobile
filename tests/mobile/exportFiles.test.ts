import { describe, expect, it, vi } from 'vitest';
import { Ester, Route, type DoseEvent, type LabResult } from '../../logic';
import type { FileSavePort, FileSaveRequest, FileSaveResult } from '../../src/platform/contracts/files';
import { saveReport } from '../../src/reports/pdf';
import { defaultReportSelection, prepareReport } from '../../src/reports/prepareReport';
import { TRANSLATIONS } from '../../src/i18n/translations';
import { reportText } from '../helpers/reportText';

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

const report = prepareReport({ events, labResults }, defaultReportSelection(), GENERATED_AT);
const t = (key: string) => (TRANSLATIONS.en as Record<string, string>)[key] ?? key;
const exportPDF = (files: FileSavePort) => saveReport(report, 'en', t, files, GENERATED_AT);

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
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

describe('PDF report save port', () => {
    it('writes real PDF bytes and stays pending until the port settles', async () => {
        const gate = deferred<FileSaveResult>();
        const delivered = portControlled(gate.promise);
        let settled = false;
        const pending = exportPDF(delivered.files);
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await vi.waitFor(() => expect(delivered.request()).toBeDefined());
        expect(settled).toBe(false);

        const request = delivered.request();
        expect(request).toBeDefined();
        expect(request?.name).toBe('hrt-report-2026-01-02.pdf');
        expect(request?.mimeType).toBe('application/pdf');
        expect(Buffer.from(request!.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        const text = reportText(request!.bytes);
        expect(text).toContain('Dose history');
        expect(text).toContain('1.25 mg');
        expect(text).toContain('Lab results');
        expect(text).toContain('95');
        expect(text).toMatch(/pg\/ml/i);
        expect(text).not.toContain('synthetic-dose');

        gate.resolve('saved');
        await expect(pending).resolves.toBe('saved');
        expect(settled).toBe(true);
    });

    it('returns cancellation from the save port', async () => {
        const delivered = portControlled(Promise.resolve('cancelled'));
        await expect(exportPDF(delivered.files)).resolves.toBe('cancelled');
        expect(delivered.request()?.mimeType).toBe('application/pdf');
    });

    it('uses the current local date in the PDF and its filename after a timezone change', async () => {
        vi.stubEnv('TZ', 'UTC');
        try {
            const when = new Date('2026-01-02T23:30:00Z');
            const delivered = portControlled(Promise.resolve('saved'));
            const save = () => saveReport(report, 'en', key => TRANSLATIONS.en[key] ?? key, delivered.files, when);
            await save();
            expect(delivered.request()?.name).toBe('hrt-report-2026-01-02.pdf');
            vi.stubEnv('TZ', 'Europe/Berlin');
            await save();
            expect(delivered.request()?.name).toBe('hrt-report-2026-01-03.pdf');
            expect(reportText(delivered.request()!.bytes)).toContain('Generated on: Jan 3, 2026');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('propagates save rejection', async () => {
        const failure = new Error('synthetic-save-failure');
        await expect(exportPDF({ save: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
    });
});
