import { describe, expect, it } from 'vitest';
import { parseDocumentUiReports } from '../../scripts/mobile/run-native-document-ui.mjs';

const names = ['sharedPdfRendersAndOpensExternally', 'systemDownloadsRoundTrip', 'systemCancellationAllowsRetry'];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const reports = (): Record<string, unknown>[] => [
    {
        test: names[0],
        outcome: 'pass',
        cleaned: true,
        temporaryPdfRemoved: true,
        pdfBytes: 7197,
        pdfSha256: 'a'.repeat(64),
        pages: 1,
        textVerified: true,
        viewerPackage: 'com.google.android.apps.docs',
        viewerOpened: true,
        renderPng: png,
        viewerPng: png,
    },
    {
        test: names[1],
        outcome: 'pass',
        cleaned: true,
        exactBytes: true,
        formats: ['json', 'csv', 'ics'].map(extension => ({ extension, bytes: 30, sha256: 'b'.repeat(64) })),
    },
    { test: names[2], outcome: 'pass', cleaned: true, saveCancelled: true, pickCancelled: true, retryExact: true },
];
const output = (values = reports(), cases = names) =>
    values
        .map(
            value =>
                `INSTRUMENTATION_STATUS: document_ui_report=${JSON.stringify(value)}\nINSTRUMENTATION_STATUS_CODE: 2\n`,
        )
        .join('') +
    cases
        .map(
            name =>
                `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.DocumentUiTest\nINSTRUMENTATION_STATUS: test=${name}\nINSTRUMENTATION_STATUS: numtests=${cases.length}\nINSTRUMENTATION_STATUS_CODE: 0\n`,
        )
        .join('') +
    `OK (${cases.length} tests)\nINSTRUMENTATION_CODE: -1\n`;

describe('system document UI evidence', () => {
    it('accepts exactly three completed cases and their complete reports', () => {
        const result = parseDocumentUiReports(output());
        expect(result.cases.map(item => item.name)).toEqual(names);
        expect(result.reports).toEqual(reports());
    });
    it.each(['missing', 'extra', 'duplicate', 'renamed'])('rejects %s JUnit coverage', kind => {
        const cases = [...names];
        if (kind === 'missing') cases.pop();
        if (kind === 'extra') cases.push('unrelated');
        if (kind === 'duplicate') cases[2] = cases[1];
        if (kind === 'renamed') cases[2] = 'unrelated';
        expect(() => parseDocumentUiReports(output(reports(), cases))).toThrow();
    });
    it.each(['missing', 'duplicate', 'failed', 'unknown'])('rejects %s reports despite passing JUnit', kind => {
        const values = reports();
        if (kind === 'missing') values.pop();
        if (kind === 'duplicate') values[2] = values[1];
        if (kind === 'failed') values[0].outcome = 'fail';
        if (kind === 'unknown') values[2].test = 'unrelated';
        expect(() => parseDocumentUiReports(output(values))).toThrow();
    });
    it('rejects missing or malformed rendering evidence and false verification markers', () => {
        for (const field of [
            'renderPng',
            'viewerPng',
            'pdfSha256',
            'textVerified',
            'temporaryPdfRemoved',
            'viewerOpened',
            'cleaned',
        ]) {
            const values = reports();
            delete values[0][field];
            expect(() => parseDocumentUiReports(output(values)), field).toThrow();
        }
        for (const field of ['renderPng', 'viewerPng']) {
            const values = reports();
            values[0][field] = 'not a PNG';
            expect(() => parseDocumentUiReports(output(values)), field).toThrow();
        }
        for (const [index, field] of [
            [0, 'viewerOpened'],
            [1, 'exactBytes'],
            [2, 'retryExact'],
        ] as const) {
            const values = reports();
            values[index][field] = false;
            expect(() => parseDocumentUiReports(output(values)), field).toThrow();
        }
    });
    it('rejects missing transport formats and non-passing instrumentation', () => {
        const values = reports();
        values[1].formats = [];
        expect(() => parseDocumentUiReports(output(values))).toThrow();
        expect(() =>
            parseDocumentUiReports(
                output().replace('INSTRUMENTATION_STATUS_CODE: 0', 'INSTRUMENTATION_STATUS_CODE: -2'),
            ),
        ).toThrow();
        expect(() =>
            parseDocumentUiReports(output().replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0')),
        ).toThrow();
    });
});
