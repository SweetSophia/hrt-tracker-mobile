import { expect, it } from 'vitest';
import {
    parseScreenPhase,
    validateScreenRun,
    SCREEN_PHASES,
} from '../../scripts/mobile/run-native-screen-migration.mjs';

import { parsePendingPreview } from '../../scripts/mobile/screen-interruption.mjs';

const digest = 'a'.repeat(64);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const reports = () => [
    {
        phase: 'screenJourneys',
        outcome: 'pass',
        pid: 100,
        cleaned: true,
        snapshotSha256: digest,
        previewNoWrite: true,
        mergeCancelledUnchanged: true,
        bothModesMerged: true,
        completeExportExact: true,
        jsonRows: 2,
        pdfTextVerified: true,
        csvRowsVerified: true,
        wrongPasswordUnchanged: true,
        csvSha256: digest,
        pdfSha256: digest,
        icsSha256: digest,
        previewPng: png,
        cancelledSaveAbsent: true,
        encryptedSaved: true,
        replaceCancelledUnchanged: true,
        bothModesReplaced: true,
        passwordCancelledUnchanged: true,
        encryptedImportExact: true,
        pickerCancelledUnchanged: true,
        retrySucceeded: true,
    },
    {
        phase: 'confirmedRestartSeed',
        outcome: 'pass',
        pid: 101,
        cleaned: true,
        snapshotSha256: digest,
        acknowledged: true,
    },
    {
        phase: 'confirmedRestartVerify',
        outcome: 'pass',
        pid: 102,
        cleaned: true,
        snapshotSha256: digest,
        reopenedExact: true,
        noReplay: true,
        exportExact: true,
    },
    {
        phase: 'pendingRestartSeed',
        outcome: 'waiting',
        holdMillis: 60000,
        pid: 103,
        cleaned: true,
        snapshotSha256: digest,
        previewOpen: true,
        unchanged: true,
    },
    {
        phase: 'pendingRestartVerify',
        outcome: 'pass',
        pid: 104,
        cleaned: true,
        snapshotSha256: digest,
        reopenedExact: true,
        noReplay: true,
        exportExact: true,
    },
];
const output = (report: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: screen_report=${JSON.stringify(report)}\nINSTRUMENTATION_STATUS_CODE: 2\n` +
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.ScreenMigrationTest\nINSTRUMENTATION_STATUS: test=${report.phase}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
const pendingOutput = (report: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.ScreenMigrationTest\nINSTRUMENTATION_STATUS: test=pendingRestartSeed\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS: screen_boundary=${JSON.stringify(report)}\nINSTRUMENTATION_STATUS_CODE: 2\n`;
const runs = () =>
    reports().map(report =>
        report.phase === 'pendingRestartSeed'
            ? {
                  phase: report.phase,
                  cases: [],
                  report: parsePendingPreview(pendingOutput(report)),
                  interruption: { livePid: report.pid, forceStopReturned: true, processGone: true },
              }
            : {
                  ...parseScreenPhase(output(report), report.phase),
                  forcedStopBefore: report.phase.endsWith('Verify'),
              },
    );

it('accepts all five exact phase reports with distinct restarted processes and matching snapshots', () => {
    expect(validateScreenRun(runs())).toHaveLength(5);
    expect(SCREEN_PHASES).toEqual(reports().map(report => report.phase));
});
it('rejects missing, duplicated, reordered or unexpected phases', () => {
    const good = runs();
    for (const bad of [good.slice(1), [...good, good[0]], [good[1], good[0], ...good.slice(2)]])
        expect(() => validateScreenRun(bad)).toThrow();
    expect(() => parseScreenPhase(output(reports()[0]), 'unrelated')).toThrow();
});
it('rejects failed or incomplete JUnit output and duplicated reports', () => {
    const text = output(reports()[0]);
    for (const bad of [
        text.replace('CODE: 0', 'CODE: -2'),
        text.replace('OK (1 test)', ''),
        text + text,
        text.replace('ScreenMigrationTest', 'OtherTest'),
        text.replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0'),
    ])
        expect(() => parseScreenPhase(bad, 'screenJourneys')).toThrow();
});
it('requires every behavioral marker, bounded PNG and document fingerprint', () => {
    for (const report of reports()) {
        for (const field of Object.keys(report)) {
            const bad: Record<string, unknown> = { ...report };
            delete bad[field];
            expect(
                () =>
                    report.phase === 'pendingRestartSeed'
                        ? parsePendingPreview(pendingOutput(bad))
                        : parseScreenPhase(output(bad), report.phase),
                `${report.phase}.${field}`,
            ).toThrow();
        }
    }
    for (const value of ['invalid', '', 'a'.repeat(600001)])
        expect(() => parseScreenPhase(output({ ...reports()[0], previewPng: value }), 'screenJourneys')).toThrow();
    expect(() => parseScreenPhase(output({ ...reports()[0], cancelledSaveAbsent: false }), 'screenJourneys')).toThrow();
});
it('rejects a fake restart, absent force-stop or changed durable snapshot', () => {
    for (const change of ['pid', 'snapshot', 'stop']) {
        const items = runs();
        if (change === 'pid') items[2].report.pid = items[1].report.pid;
        if (change === 'snapshot') items[2].report.snapshotSha256 = 'b'.repeat(64);
        if (change === 'stop') items[2].forcedStopBefore = false;
        expect(() => validateScreenRun(items)).toThrow();
    }
});

it('rejects a normally completed pending preview seed even if a later force-stop is reported', () => {
    expect(() => parseScreenPhase(output({ ...reports()[3], outcome: 'pass' }), 'pendingRestartSeed')).toThrow();
});

it('requires a proven interruption rather than an empty completed-test record', () => {
    for (const field of ['livePid', 'forceStopReturned', 'processGone']) {
        const items = runs();
        delete items[3].interruption[field];
        expect(() => validateScreenRun(items)).toThrow();
    }
});
