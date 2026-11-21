import { expect, it } from 'vitest';
import { parsePlanningPhase, validatePlanningRun } from '../../scripts/mobile/run-native-planning-settings.mjs';

const names = ['onboardingSettingsSeed', 'onboardingSettingsVerify', 'plansSuppliesSeed', 'plansSuppliesVerify'];
const flags = [
    { onboardingComplete: true, enZhSwitched: true, languageSaved: true, recordsUnchanged: true },
    { reopenedExact: true, onboardingSkipped: true, chineseRetained: true },
    { bothModesCreated: true, scopeIsolated: true, exactValues: true, acknowledged: true },
    { reopenedExact: true, bothModesRendered: true, noDuplicates: true, savedSupplyRowsControlled: true },
];
const report = (index: number) => ({
    phase: names[index],
    outcome: 'pass',
    pid: 100 + index,
    snapshotSha256: (index < 2 ? 'a' : 'b').repeat(64),
    ...flags[index],
});
const output = (r: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: parity_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\n` +
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.PlanningSettingsTest\nINSTRUMENTATION_STATUS: test=${r.phase}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
const runs = () =>
    names.map((name, index) => ({
        ...parsePlanningPhase(output(report(index)), name),
        forcedStopBefore: index % 2 === 1,
        processGoneBefore: index % 2 === 1,
    }));

it('requires one completed native planning/settings case and all asserted evidence for its phase', () => {
    for (let index = 0; index < names.length; index++) {
        const r = report(index);
        expect(parsePlanningPhase(output(r), names[index]).cases).toHaveLength(1);
        for (const key of Object.keys(r)) {
            expect(() => parsePlanningPhase(output({ ...r, [key]: false }), names[index])).toThrow();
            const missing: Record<string, unknown> = { ...r };
            delete missing[key];
            expect(() => parsePlanningPhase(output(missing), names[index])).toThrow();
        }
        for (const change of [{ pid: 0 }, { pid: 1.5 }, { outcome: 'waiting' }, { snapshotSha256: 'bad' }])
            expect(() => parsePlanningPhase(output({ ...r, ...change }), names[index])).toThrow();
        expect(() => parsePlanningPhase(output(r).replace('OK (1 test)', 'FAILURES!!!'), names[index])).toThrow();
        expect(() =>
            parsePlanningPhase(output(r).replaceAll('storage.PlanningSettingsTest', 'storage.OtherTest'), names[index]),
        ).toThrow();
        expect(() =>
            parsePlanningPhase(output(r).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'), names[index]),
        ).toThrow();
        expect(() => parsePlanningPhase(output(r) + output(r), names[index])).toThrow();
    }
    expect(() => parsePlanningPhase(output(report(0)), 'unknown')).toThrow();
    expect(() => parsePlanningPhase(output(report(0)), names[1])).toThrow();
    expect(() => parsePlanningPhase('', names[0])).toThrow();
});

it('requires the exact planning/settings sequence and fresh process with identical durable state', () => {
    expect(validatePlanningRun(runs())).toHaveLength(4);
    for (const list of [runs().slice(1), [...runs(), runs()[0]], runs().reverse()])
        expect(() => validatePlanningRun(list)).toThrow();
    for (const index of [1, 3])
        for (const change of [
            (r: ReturnType<typeof runs>) => {
                r[index].forcedStopBefore = false;
            },
            (r: ReturnType<typeof runs>) => {
                r[index].processGoneBefore = false;
            },
            (r: ReturnType<typeof runs>) => {
                r[index].report.pid = r[index - 1].report.pid;
            },
            (r: ReturnType<typeof runs>) => {
                r[index].report.snapshotSha256 = 'c'.repeat(64);
            },
            (r: ReturnType<typeof runs>) => {
                r[index - 1].forcedStopBefore = true;
            },
        ]) {
            const r = runs();
            change(r);
            expect(() => validatePlanningRun(r)).toThrow();
        }
});
