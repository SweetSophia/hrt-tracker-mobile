import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveEvidence } from '../../scripts/mobile/backup-evidence.mjs';
import { expect, it } from 'vitest';
import { parseLongHistoryReport, writeLongHistoryEvidence } from '../../scripts/mobile/run-native-long-history.mjs';
const report = () => ({
    outcome: 'pass',
    measurementOnly: true,
    performanceAccepted: false,
    localOrigin: true,
    snapshotUnchanged: true,
    beforeHash: 'a'.repeat(64),
    afterHash: 'a'.repeat(64),
    checks: {
        ordinaryHook: true,
        cappedGrid: true,
        settledPresentation: true,
        workerProgress: true,
        snapshotStable: true,
        phaseOrder: true,
    },
    trace: {
        phase: 'complete',
        attempts: 1,
        discardedAttempts: 0,
        workerId: 1,
        requestId: 7,
        events: 43,
        method: 'mcmc',
        samples: 100_300,
        screenSamples: 102_000,
        frames: 2,
        metrics: {
            actionToPostMs: 10,
            postToStartedMs: 10,
            startedToResultMs: 60,
            resultToFrameMs: 40,
            totalMs: 120,
            ticks: 2,
            workerTicks: 1,
            maxGapMs: 95,
        },
    },
});
const output = (r: unknown) =>
    `INSTRUMENTATION_STATUS: long_history_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\nINSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.LongHistoryPerformanceTest\nINSTRUMENTATION_STATUS: test=ordinaryCappedHistory\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
it('accepts only a completed measurement, never a latency-budget acceptance claim', () => {
    expect(parseLongHistoryReport(output(report())).cases).toHaveLength(1);
    expect(
        parseLongHistoryReport(
            output({
                ...report(),
                trace: { ...report().trace, metrics: { ...report().trace.metrics, maxGapMs: 110 } },
            }),
        ).cases,
    ).toHaveLength(1);
    expect(
        parseLongHistoryReport(output({ ...report(), trace: { ...report().trace, attempts: 2, discardedAttempts: 1 } }))
            .cases,
    ).toHaveLength(1);
    for (const key of Object.keys(report().checks)) {
        const r = report();
        r.checks[key] = false;
        expect(() => parseLongHistoryReport(output(r))).toThrow();
        delete r.checks[key];
        expect(() => parseLongHistoryReport(output(r))).toThrow();
    }
    for (const text of [
        '',
        output(report()) + output(report()),
        output(report()).replace('OK (1 test)', 'FAILURES!!!'),
        output(report()).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
        output(report()).replace('LongHistoryPerformanceTest', 'AppEngineWorkerTest'),
        output(report()).replace('test=ordinaryCappedHistory', 'test=ordinaryScreenModel'),
    ])
        expect(() => parseLongHistoryReport(text)).toThrow();
});
it.each(
    [
        { measurementOnly: false },
        { performanceAccepted: true },
        { localOrigin: false },
        { snapshotUnchanged: false },
        { afterHash: 'b'.repeat(64) },
        { beforeHash: 'a'.repeat(63) },
        { outcome: 'fail' },
        { checks: { ...report().checks, extra: true } },
    ].map(change => ({ change })),
)('rejects invalid measurement evidence: $change', ({ change }) => {
    expect(() => parseLongHistoryReport(output({ ...report(), ...change }))).toThrow();
});
it.each(
    [
        { attempts: undefined },
        { attempts: 0 },
        { attempts: 3, discardedAttempts: 1 },
        { discardedAttempts: -1 },
        { discardedAttempts: 0.5 },
        { phase: 'rendering' },
        { phase: 'worker' },
        { frames: 1 },
        { frames: 3 },
        { workerId: 0 },
        { requestId: 1.5 },
        { method: 'off' },
        { events: 42 },
        { samples: 99_999 },
        { samples: 101_000 },
        { screenSamples: 100 },
        { metrics: { ...report().trace.metrics, workerTicks: 0 } },
        { metrics: { ...report().trace.metrics, ticks: 0 } },
        { metrics: { ...report().trace.metrics, workerTicks: 3 } },
        { metrics: { ...report().trace.metrics, ticks: 2.5 } },
        { metrics: { ...report().trace.metrics, actionToPostMs: -1 } },
        { metrics: { ...report().trace.metrics, startedToResultMs: 0 } },
        { metrics: { ...report().trace.metrics, resultToFrameMs: 0 } },
        { metrics: { ...report().trace.metrics, totalMs: 121 } },
        { metrics: { ...report().trace.metrics, maxGapMs: 121 } },
        { metrics: { ...report().trace.metrics, maxGapMs: Infinity } },
    ].map(change => ({ change })),
)('rejects incomplete or incoherent timing: $change', ({ change }) => {
    expect(() => parseLongHistoryReport(output({ ...report(), trace: { ...report().trace, ...change } }))).toThrow();
});

it('writes default passing XML only after completed native evidence is validated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrt-profile-output-'));
    const path = join(dir, 'default');
    const evidence = reserveEvidence(path);
    try {
        writeLongHistoryEvidence(
            { avd: 'HRT_Feasibility_API36', serial: 'emulator-5580', pageSize: 4096 },
            output(report()),
            { profiled: false },
            evidence,
        );
        expect(readFileSync(path + '.xml', 'utf8')).toContain('name="ordinaryCappedHistory"');
    } finally {
        evidence.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
it.each([undefined, { complete: true, dataLossOccurred: false, traceEvents: [] }])(
    'keeps passing XML empty when a profiled native success has no valid trace',
    capture => {
        const dir = mkdtempSync(join(tmpdir(), 'hrt-profile-output-'));
        const path = join(dir, 'rejected');
        const evidence = reserveEvidence(path, ['trace.json']);
        try {
            expect(() =>
                writeLongHistoryEvidence(
                    { avd: 'HRT_Feasibility_API36', serial: 'emulator-5580', pageSize: 4096 },
                    output({ ...report(), rendererProfile: true }),
                    { profiled: true, capture },
                    evidence,
                ),
            ).toThrow();
            expect(readFileSync(path + '.xml', 'utf8')).toBe('');
        } finally {
            evidence.close();
            rmSync(dir, { recursive: true, force: true });
        }
    },
);

it.each([undefined, 'worker'])('requires the native comparison mode to match %s before writing passing XML', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'hrt-delivery-output-'));
    const path = join(dir, 'wrong-mode');
    const evidence = reserveEvidence(path, ['trace.json']);
    const native = { ...report(), rendererProfile: true, deliveryComparison: { mode: 'preloaded' } };
    try {
        expect(() =>
            writeLongHistoryEvidence(
                { avd: 'HRT_Feasibility_API36', serial: 'emulator-5580', pageSize: 4096 },
                output(native),
                { profiled: true, deliveryMode: mode, capture: {} },
                evidence,
            ),
        ).toThrow('Unmatched delivery comparison mode');
        expect(readFileSync(path + '.xml', 'utf8')).toBe('');
    } finally {
        evidence.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
