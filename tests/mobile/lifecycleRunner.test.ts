import { expect, it } from 'vitest';
import { parseLifecyclePhase, validateLifecycleRun } from '../../scripts/mobile/run-native-lifecycle.mjs';

const names = ['draftLifecycle', 'acknowledgedEditsSeed', 'acknowledgedEditsVerify'];
const flags = [
    { backgroundDraftRetained: true, rotationDraftRetained: true, recreationNoReplay: true, unchanged: true },
    {
        bothModesSaved: true,
        scopeIsolated: true,
        acknowledged: true,
        backgroundUnchanged: true,
        recreationUnchanged: true,
    },
    { reopenedExact: true, noReplay: true, bothModesExact: true },
];
const report = (index: number) => ({
    phase: names[index],
    outcome: 'pass',
    pid: 100 + index,
    snapshotSha256: 'a'.repeat(64),
    ...flags[index],
});
const output = (r: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: lifecycle_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\n` +
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.LifecycleParityTest\nINSTRUMENTATION_STATUS: test=${r.phase}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
const runs = () =>
    names.map((name, index) => ({
        ...parseLifecyclePhase(output(report(index)), name),
        forcedStopBefore: index === 2,
        processGoneBefore: index === 2,
    }));

it('requires one completed native lifecycle case and all asserted evidence for its phase', () => {
    for (let index = 0; index < names.length; index++) {
        const r = report(index);
        expect(parseLifecyclePhase(output(r), names[index]).cases).toHaveLength(1);
        for (const key of Object.keys(flags[index])) {
            expect(() => parseLifecyclePhase(output({ ...r, [key]: false }), names[index])).toThrow();
            const missing: Record<string, unknown> = { ...r };
            delete missing[key];
            expect(() => parseLifecyclePhase(output(missing), names[index])).toThrow();
        }
        for (const change of [{ pid: 0 }, { pid: 1.5 }, { outcome: 'waiting' }, { snapshotSha256: 'bad' }])
            expect(() => parseLifecyclePhase(output({ ...r, ...change }), names[index])).toThrow();
        expect(() => parseLifecyclePhase(output(r).replace('OK (1 test)', 'FAILURES!!!'), names[index])).toThrow();
        expect(() =>
            parseLifecyclePhase(output(r).replaceAll('storage.LifecycleParityTest', 'storage.OtherTest'), names[index]),
        ).toThrow();
        expect(() =>
            parseLifecyclePhase(output(r).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'), names[index]),
        ).toThrow();
        expect(() => parseLifecyclePhase(output(r) + output(r), names[index])).toThrow();
    }
    expect(() => parseLifecyclePhase(output(report(0)), 'unknown')).toThrow();
    expect(() => parseLifecyclePhase(output(report(0)), names[1])).toThrow();
    expect(() => parseLifecyclePhase('', names[0])).toThrow();
});

it('requires the exact lifecycle sequence and fresh process with identical durable state', () => {
    expect(validateLifecycleRun(runs())).toHaveLength(3);
    for (const list of [runs().slice(1), [...runs(), runs()[0]], runs().reverse()])
        expect(() => validateLifecycleRun(list)).toThrow();
    for (const change of [
        (r: ReturnType<typeof runs>) => {
            r[2].forcedStopBefore = false;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].processGoneBefore = false;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.pid = r[1].report.pid;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.snapshotSha256 = 'b'.repeat(64);
        },
    ]) {
        const r = runs();
        change(r);
        expect(() => validateLifecycleRun(r)).toThrow();
    }
});
