import { expect, it } from 'vitest';
import { parseDemoWorkerReport } from '../../scripts/mobile/run-native-demo-worker.mjs';
const KINDS = ['onboarding', 'model-guide', 'calibration-guide', 'sandbox'];
const report = () => ({
    outcome: 'pass',
    snapshotUnchanged: true,
    localOrigin: true,
    beforeHash: 'a'.repeat(64),
    afterHash: 'a'.repeat(64),
    kinds: [...KINDS],
    mcmcJobs: [
        { ticks: 3, maxGapMs: 5, roundTripMs: 50 },
        { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
    ],
    checks: {
        ordinaryDemos: true,
        sharedWorker: true,
        rendererProgress: true,
        exactBatch: true,
        draftsRetained: true,
        failureVisible: true,
        retrySucceeded: true,
        recordsUnchanged: true,
    },
    metrics: { requests: 6, results: 5, mcmcResults: 2, ticks: 10, maxGapMs: 5, roundTripMs: 100 },
});
const output = (r: unknown) =>
    `INSTRUMENTATION_STATUS: demo_worker_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\nINSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.DemoEngineWorkerTest\nINSTRUMENTATION_STATUS: test=ordinaryEducationalDemos\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
it('accepts only a completed ordinary educational demo case with exact kinds, checks and matching durable hashes', () => {
    expect(parseDemoWorkerReport(output(report())).cases).toHaveLength(1);
    expect(
        parseDemoWorkerReport(
            output({
                ...report(),
                kinds: [...KINDS].reverse(),
                mcmcJobs: [{ ticks: 1, maxGapMs: 0, roundTripMs: 0.5 }],
                metrics: { requests: 5, results: 4, mcmcResults: 1, ticks: 1, maxGapMs: 0, roundTripMs: 0.5 },
            }),
        ).cases,
    ).toHaveLength(1);
    for (const key of Object.keys(report().checks)) {
        const r = report();
        r.checks[key] = false;
        expect(() => parseDemoWorkerReport(output(r))).toThrow();
        delete r.checks[key];
        expect(() => parseDemoWorkerReport(output(r))).toThrow();
    }
    expect(() =>
        parseDemoWorkerReport(output({ ...report(), checks: { ...report().checks, surplus: true } })),
    ).toThrow();
    const missingKinds = report();
    delete missingKinds.kinds;
    const incomplete = report();
    delete incomplete.snapshotUnchanged;
    delete incomplete.localOrigin;
    delete incomplete.beforeHash;
    expect(() => parseDemoWorkerReport(output(incomplete))).toThrow();
    for (const kinds of [
        missingKinds.kinds,
        KINDS.slice(0, 3),
        [...KINDS, 'onboarding'],
        ['onboarding', 'onboarding', 'model-guide', 'sandbox'],
        [...KINDS, 'extra'],
        ['onboarding', 'model-guide', 'calibration-guide', 'other'],
        [],
        'onboarding',
    ])
        expect(() => parseDemoWorkerReport(output({ ...report(), kinds }))).toThrow();
    for (const change of [
        { afterHash: 'b'.repeat(64) },
        { beforeHash: 'A'.repeat(64), afterHash: 'A'.repeat(64) },
        { beforeHash: 'a'.repeat(63) },
        { outcome: 'fail' },
        { snapshotUnchanged: false },
        { localOrigin: false },
        { checks: { ...report().checks, ordinaryDemos: 'true' } },
        { metrics: { ...report().metrics, ticks: 0 } },
        { metrics: { ...report().metrics, ticks: 1.5 } },
        { metrics: { ...report().metrics, requests: 4 } },
        { metrics: { ...report().metrics, requests: 5.5 } },
        { metrics: { ...report().metrics, results: 3 } },
        { metrics: { ...report().metrics, mcmcResults: 0 } },
        { metrics: { ...report().metrics, mcmcResults: 1.2 } },
        { metrics: { ...report().metrics, maxGapMs: -1 } },
        { metrics: { ...report().metrics, maxGapMs: Number.POSITIVE_INFINITY } },
        { metrics: { ...report().metrics, roundTripMs: 0 } },
        { metrics: { ...report().metrics, roundTripMs: Number.NaN } },
    ])
        expect(() => parseDemoWorkerReport(output({ ...report(), ...change }))).toThrow();
    const duplicateReport = output(report()).replace(
        `demo_worker_report=${JSON.stringify(report())}`,
        `demo_worker_report=${JSON.stringify(report())}\nINSTRUMENTATION_STATUS: demo_worker_report=${JSON.stringify(report())}`,
    );
    for (const text of [
        '',
        '<?xml version="1.0" encoding="UTF-8"?><testsuite name="android-demo-worker" tests="1" failures="0"/>',
        output(report()) + output(report()),
        output(report()).replace('OK (1 test)', 'FAILURES!!!'),
        output(report()).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
        output(report()).replace('test=ordinaryEducationalDemos', 'test=ordinaryForecast'),
        output(report()).replace('DemoEngineWorkerTest', 'ForecastEngineWorkerTest'),
        output(report()).replace('demo_worker_report=', 'forecast_worker_report='),
        output('{'),
        duplicateReport,
    ])
        expect(() => parseDemoWorkerReport(text)).toThrow();
});

it.each(
    [
        undefined,
        [],
        [{ ticks: 1, maxGapMs: 5, roundTripMs: 20 }],
        [
            { ticks: 0, maxGapMs: 5, roundTripMs: 20 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1.5, maxGapMs: 5, roundTripMs: 20 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1, maxGapMs: -1, roundTripMs: 20 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1, maxGapMs: 6, roundTripMs: 20 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1, maxGapMs: 5, roundTripMs: 0 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1, maxGapMs: 5, roundTripMs: 101 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 7, maxGapMs: 5, roundTripMs: 20 },
            { ticks: 7, maxGapMs: 5, roundTripMs: 80 },
        ],
        [
            { ticks: 1, roundTripMs: 20 },
            { ticks: 4, maxGapMs: 5, roundTripMs: 80 },
        ],
    ].map(mcmcJobs => ({ mcmcJobs })),
)('rejects incomplete or individually non-progressing MCMC jobs: $mcmcJobs', ({ mcmcJobs }) => {
    expect(() => parseDemoWorkerReport(output({ ...report(), mcmcJobs }))).toThrow();
});
