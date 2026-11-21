import { expect, it } from 'vitest';
import { parseAppEngineWorkerReport } from '../../scripts/mobile/run-native-app-engine-worker.mjs';
const report = () => ({
    outcome: 'pass',
    snapshotUnchanged: true,
    localOrigin: true,
    beforeHash: 'a'.repeat(64),
    afterHash: 'a'.repeat(64),
    checks: {
        ordinaryHook: true,
        exactSamples: true,
        rendererProgress: true,
        readoutTick: true,
        baselineStable: true,
        failureVisible: true,
        retrySucceeded: true,
        recordsUnchanged: true,
    },
    metrics: { requests: 4, results: 3, mcmcResults: 3, ticks: 10, maxGapMs: 5, roundTripMs: 100 },
});
const output = (r: unknown) =>
    `INSTRUMENTATION_STATUS: app_engine_worker_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\nINSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.AppEngineWorkerTest\nINSTRUMENTATION_STATUS: test=ordinaryScreenModel\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
it('accepts only a completed ordinary-screen case with all assertions and matching durable hashes', () => {
    expect(parseAppEngineWorkerReport(output(report())).cases).toHaveLength(1);
    for (const key of Object.keys(report().checks)) {
        const r = report();
        r.checks[key] = false;
        expect(() => parseAppEngineWorkerReport(output(r))).toThrow();
        delete r.checks[key];
        expect(() => parseAppEngineWorkerReport(output(r))).toThrow();
    }
    for (const change of [
        { afterHash: 'b'.repeat(64) },
        { outcome: 'fail' },
        { snapshotUnchanged: false },
        { metrics: { ...report().metrics, ticks: 0 } },
        { metrics: { ...report().metrics, mcmcResults: 0 } },
    ])
        expect(() => parseAppEngineWorkerReport(output({ ...report(), ...change }))).toThrow();
    for (const text of [
        '',
        output(report()) + output(report()),
        output(report()).replace('OK (1 test)', 'FAILURES!!!'),
        output(report()).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
    ])
        expect(() => parseAppEngineWorkerReport(text)).toThrow();
});
