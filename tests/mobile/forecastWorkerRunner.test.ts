import { expect, it } from 'vitest';
import { parseForecastWorkerReport } from '../../scripts/mobile/run-native-forecast-worker.mjs';
const report = () => ({
    outcome: 'pass',
    snapshotUnchanged: true,
    localOrigin: true,
    beforeHash: 'a'.repeat(64),
    afterHash: 'a'.repeat(64),
    checks: {
        ordinaryForecast: true,
        sharedWorker: true,
        rendererProgress: true,
        exactBatch: true,
        draftsRetained: true,
        failureVisible: true,
        retrySucceeded: true,
        recordsUnchanged: true,
    },
    metrics: { requests: 4, results: 3, mcmcResults: 3, ticks: 10, maxGapMs: 5, roundTripMs: 100 },
});
const output = (r: unknown) =>
    `INSTRUMENTATION_STATUS: forecast_worker_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\nINSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.ForecastEngineWorkerTest\nINSTRUMENTATION_STATUS: test=ordinaryForecast\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
it('accepts only a completed ordinary Forecast case with all checks and matching durable hashes', () => {
    expect(parseForecastWorkerReport(output(report())).cases).toHaveLength(1);
    expect(
        parseForecastWorkerReport(
            output({
                ...report(),
                metrics: { requests: 2, results: 2, mcmcResults: 1, ticks: 1, maxGapMs: 0, roundTripMs: 1 },
            }),
        ).cases,
    ).toHaveLength(1);
    for (const key of Object.keys(report().checks)) {
        const r = report();
        r.checks[key] = false;
        expect(() => parseForecastWorkerReport(output(r))).toThrow();
        delete r.checks[key];
        expect(() => parseForecastWorkerReport(output(r))).toThrow();
    }
    expect(() =>
        parseForecastWorkerReport(output({ ...report(), checks: { ...report().checks, surplus: true } })),
    ).toThrow();
    for (const change of [
        { afterHash: 'b'.repeat(64) },
        { outcome: 'fail' },
        { snapshotUnchanged: false },
        { localOrigin: false },
        { metrics: { ...report().metrics, ticks: 0 } },
        { metrics: { ...report().metrics, ticks: 1.5 } },
        { metrics: { ...report().metrics, requests: 1 } },
        { metrics: { ...report().metrics, results: 1 } },
        { metrics: { ...report().metrics, mcmcResults: 0 } },
        { metrics: { ...report().metrics, maxGapMs: -1 } },
        { metrics: { ...report().metrics, roundTripMs: 0 } },
    ])
        expect(() => parseForecastWorkerReport(output({ ...report(), ...change }))).toThrow();
    for (const text of [
        '',
        output(report()) + output(report()),
        output(report()).replace('OK (1 test)', 'FAILURES!!!'),
        output(report()).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
        output(report()).replace('test=ordinaryForecast', 'test=ordinaryScreenModel'),
    ])
        expect(() => parseForecastWorkerReport(text)).toThrow();
});
