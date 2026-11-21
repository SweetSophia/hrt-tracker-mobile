import { expect, it } from 'vitest';
import { parseStartupPhase, validateStartupRun } from '../../scripts/mobile/run-native-startup-network.mjs';

const names = ['freshStartup', 'seedDormantCredentials', 'restartDormantCredentials', 'observerControls'];
const documents = [1, 1, 2, 1];
const channels = ['beacon', 'csp', 'fetch', 'resource', 'websocket', 'xhr'];
const flags = ['earlyObserver', 'online', 'localOrigin', 'noServiceWorker', 'ordinaryPluginsOnly'];
const report = (index: number) => ({
    phase: names[index],
    outcome: 'pass',
    pid: 100 + index,
    earlyObserver: true,
    online: true,
    localOrigin: true,
    noServiceWorker: true,
    ordinaryPluginsOnly: true,
    automaticAttempts: 0,
    observedDocuments: documents[index],
    ...(index === 1 || index === 2 ? { fixtureSha256: 'a'.repeat(64) } : {}),
    ...(index === 3 ? { controlChannels: channels } : {}),
});
const output = (r: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: startup_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\n` +
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.network.StartupNetworkTest\nINSTRUMENTATION_STATUS: test=${r.phase}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
const runs = () =>
    names.map((name, index) => ({
        ...parseStartupPhase(output(report(index)), name),
        forcedStopBefore: index === 2,
        processGoneBefore: index === 2,
    }));

it('requires one completed startup-network case and all asserted evidence for its phase', () => {
    for (let index = 0; index < names.length; index++) {
        const r = report(index);
        expect(parseStartupPhase(output(r), names[index]).cases).toHaveLength(1);
        for (const key of flags) {
            expect(() => parseStartupPhase(output({ ...r, [key]: false }), names[index])).toThrow();
            const missing: Record<string, unknown> = { ...r };
            delete missing[key];
            expect(() => parseStartupPhase(output(missing), names[index])).toThrow();
        }
        for (const change of [
            { pid: 0 },
            { pid: 1.5 },
            { outcome: 'waiting' },
            { automaticAttempts: 1 },
            { observedDocuments: documents[index] + 1 },
        ])
            expect(() => parseStartupPhase(output({ ...r, ...change }), names[index])).toThrow();
        const missingCount: Record<string, unknown> = { ...r };
        delete missingCount.automaticAttempts;
        delete missingCount.observedDocuments;
        expect(() => parseStartupPhase(output(missingCount), names[index])).toThrow();
        expect(() => parseStartupPhase(output(r).replace('OK (1 test)', 'FAILURES!!!'), names[index])).toThrow();
        expect(() =>
            parseStartupPhase(output(r).replaceAll('network.StartupNetworkTest', 'network.OtherTest'), names[index]),
        ).toThrow();
        expect(() => parseStartupPhase(output(r).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'), names[index])).toThrow();
        expect(() => parseStartupPhase(output(r) + output(r), names[index])).toThrow();
        expect(() =>
            parseStartupPhase(
                output(r).replace(
                    'INSTRUMENTATION_STATUS_CODE: 2',
                    `INSTRUMENTATION_STATUS: startup_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2`,
                ),
                names[index],
            ),
        ).toThrow();
    }
    const seeded = report(1);
    for (const fixtureSha256 of [undefined, 'bad', 'A'.repeat(64), 'a'.repeat(63)]) {
        const next = { ...seeded, fixtureSha256 };
        if (fixtureSha256 === undefined) delete next.fixtureSha256;
        expect(() => parseStartupPhase(output(next), names[1])).toThrow();
        expect(() =>
            parseStartupPhase(output({ ...report(2), fixtureSha256: next.fixtureSha256 }), names[2]),
        ).toThrow();
    }
    const controls = report(3);
    for (const controlChannels of [
        undefined,
        ['fetch', 'xhr', 'beacon', 'websocket', 'csp'],
        ['fetch', 'xhr', 'beacon', 'websocket', 'csp', 'resource', 'fetch'],
        ['fetch', 'fetch', 'xhr', 'beacon', 'websocket', 'csp'],
        ['fetch', 'xhr', 'beacon', 'websocket', 'csp', 'other'],
        'fetch,xhr,beacon,websocket,csp,resource',
    ]) {
        const next: Record<string, unknown> = { ...controls, controlChannels };
        if (controlChannels === undefined) delete next.controlChannels;
        expect(() => parseStartupPhase(output(next), names[3])).toThrow();
    }
    expect(
        parseStartupPhase(
            output({ ...controls, controlChannels: ['fetch', 'xhr', 'beacon', 'websocket', 'csp', 'resource'] }),
            names[3],
        ).cases,
    ).toHaveLength(1);
    expect(() => parseStartupPhase(output(report(0)), 'unknown')).toThrow();
    expect(() => parseStartupPhase(output(report(0)), names[1])).toThrow();
    expect(() => parseStartupPhase('', names[0])).toThrow();
});

it('requires the exact startup-network sequence and a new process with the same fixture', () => {
    expect(validateStartupRun(runs())).toHaveLength(4);
    for (const list of [runs().slice(1), [...runs(), runs()[0]], runs().reverse()])
        expect(() => validateStartupRun(list)).toThrow();
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
            r[2].report.fixtureSha256 = 'b'.repeat(64);
        },
    ]) {
        const r = runs();
        change(r);
        expect(() => validateStartupRun(r)).toThrow();
    }
});
