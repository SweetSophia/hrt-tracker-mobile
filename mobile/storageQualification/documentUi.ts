import { Ester, Route } from '../../logic';
import { exportToPDF } from '../../src/services/export';
import type { FileSavePort, FileSaveResult } from '../../src/platform/contracts/files';

/** Synthetic renderer fixture; uses the actual exporter and delivery port. */
export function saveQualificationPdf(files: FileSavePort): Promise<FileSaveResult> {
    const timeH = Date.parse('2026-01-01T12:00:00Z') / 3_600_000;
    return exportToPDF(
        {
            events: [
                { id: 'synthetic-pdf-dose', route: Route.injection, ester: Ester.EV, doseMG: 12.5, timeH, extras: {} },
            ],
            labResults: [
                { id: 'synthetic-pdf-e2', timeH, concValue: 95, unit: 'pg/ml' },
                { id: 'synthetic-pdf-t', timeH, concValue: 425, unit: 'ng/dl' },
            ],
            weight: 72,
            lang: 'en',
            t: key => key,
        },
        files,
    );
}
