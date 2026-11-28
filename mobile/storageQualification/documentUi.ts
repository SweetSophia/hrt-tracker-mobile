import { Ester, Route } from '../../logic';
import { TRANSLATIONS } from '../../src/i18n/translations';
import type { FileSavePort, FileSaveResult } from '../../src/platform/contracts/files';
import { saveReport } from '../../src/reports/pdf';
import { defaultReportSelection, prepareReport } from '../../src/reports/prepareReport';

/** Synthetic renderer fixture; uses the actual exporter and delivery port. */
export function saveQualificationPdf(files: FileSavePort): Promise<FileSaveResult> {
    const timeH = Date.parse('2026-01-01T12:00:00Z') / 3_600_000;
    const now = new Date();
    const report = prepareReport(
        {
            events: [
                { id: 'synthetic-pdf-dose', route: Route.injection, ester: Ester.EV, doseMG: 12.5, timeH, extras: {} },
            ],
            labResults: [
                { id: 'synthetic-pdf-e2', timeH, concValue: 95, unit: 'pg/ml' },
                { id: 'synthetic-pdf-t', timeH, concValue: 425, unit: 'ng/dl' },
            ],
        },
        { ...defaultReportSelection(), range: 'all', bothModes: true },
        now,
    );
    const t = (key: string) => (TRANSLATIONS.en as Record<string, string>)[key] ?? key;
    return saveReport(report, 'en', t, files, now);
}
