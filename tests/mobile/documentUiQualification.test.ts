import { describe, expect, it } from 'vitest';
import { saveQualificationPdf } from '../../mobile/storageQualification/documentUi';
import type { FileSaveResult } from '../../src/platform/contracts/files';

describe('system document UI qualification PDF', () => {
    it('delivers a real shared PDF with pinned synthetic dose and both lab types', async () => {
        let calls = 0;
        const outcome = await saveQualificationPdf({
            save: async file => {
                calls++;
                expect(file.name).toMatch(/^hrt-report-\d{4}-\d{2}-\d{2}\.pdf$/);
                expect(file.mimeType).toBe('application/pdf');
                const pdf = new TextDecoder().decode(file.bytes);
                expect(pdf.startsWith('%PDF-')).toBe(true);
                for (const text of ['12.5 mg', 'injection', 'EV', '95 pg/ml', '425 ng/dl', '(E2)', '(T)'])
                    expect(pdf).toContain(text);
                return 'saved';
            },
        });
        expect(outcome).toBe('saved');
        expect(calls).toBe(1);
    });

    it('waits for delivery and preserves cancellation', async () => {
        let finish!: (value: FileSaveResult) => void;
        let settled = false;
        const pending = saveQualificationPdf({
            save: () => new Promise(resolve => (finish = resolve)),
        }).then(value => {
            settled = true;
            return value;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        finish('cancelled');
        expect(await pending).toBe('cancelled');
    });

    it('propagates a rejected native delivery without claiming a save', async () => {
        const error = new Error('synthetic provider failure');
        await expect(saveQualificationPdf({ save: async () => Promise.reject(error) })).rejects.toBe(error);
    });
});
