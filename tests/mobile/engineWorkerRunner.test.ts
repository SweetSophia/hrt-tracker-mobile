import { expect, it } from 'vitest';
import { parseEngineWorkerReport } from '../../scripts/mobile/run-native-engine-worker.mjs';
const report = () => ({
    outcome: 'pass',
    snapshotUnchanged: true,
    localOrigin: true,
    checks: {
        reference: true,
        parameterIsolation: true,
        cloneable: true,
        heartbeat: true,
        latestOnly: true,
        activeCancelled: true,
        scopeFenced: true,
        uiParametersUnchanged: true,
        uiClockUnchanged: true,
    },
    metrics: { ticks: 10, maxGapMs: 5, roundTripMs: 100, workersCreated: 3 },
});
const output = (r: unknown) =>
    `INSTRUMENTATION_STATUS: engine_worker_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\nINSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.EngineWorkerTest\nINSTRUMENTATION_STATUS: test=bundledWorkerBoundary\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
it('requires the completed native worker case and every asserted boundary check', () => {
    expect(parseEngineWorkerReport(output(report())).cases).toHaveLength(1);
    for (const key of Object.keys(report().checks)) {
        const r = report();
        r.checks[key] = false;
        expect(() => parseEngineWorkerReport(output(r))).toThrow();
        delete r.checks[key];
        expect(() => parseEngineWorkerReport(output(r))).toThrow();
    }
    for (const change of [
        { outcome: 'fail' },
        { snapshotUnchanged: false },
        { localOrigin: false },
        { metrics: { ticks: 0, maxGapMs: 5, roundTripMs: 100, workersCreated: 3 } },
        { metrics: { ticks: 10, maxGapMs: -1, roundTripMs: 100, workersCreated: 3 } },
        { metrics: { ticks: 10, maxGapMs: 5, roundTripMs: 100, workersCreated: 1 } },
    ])
        expect(() => parseEngineWorkerReport(output({ ...report(), ...change }))).toThrow();
    for (const text of [
        '',
        output(report()) + output(report()),
        output(report()).replace('OK (1 test)', 'FAILURES!!!'),
        output(report()).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
        output(report()).replaceAll('storage.EngineWorkerTest', 'storage.OtherTest'),
    ])
        expect(() => parseEngineWorkerReport(text)).toThrow();
});
