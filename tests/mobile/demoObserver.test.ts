import { afterEach, expect, it, vi } from 'vitest';
import fixtures from './fixtures/demo-baseline.json';
import { installDemoWorkerQualification } from '../../mobile/storageQualification/demoWorker';
import { executeDemoTask } from '../../src/application/demoTask';
import type { DemoTaskInput } from '../../src/application/demoProtocol';
class Port extends EventTarget {
    postMessage(_request: unknown) {}
    terminate() {}
}
interface Report {
    sharedWorker: boolean;
    metrics: { maxGapMs: number; roundTripMs: number; ticks: number };
    mcmcJobs: { ticks: number; maxGapMs: number; roundTripMs: number }[];
}
const setup = () => {
    const callbacks: (() => void)[] = [];
    const host = {
        Worker: Port,
        setInterval: (fn: () => void) => callbacks.push(fn),
        clearInterval: () => {},
        __hrtDemoWorkerQualification: undefined as unknown as {
            read(): Report;
            setMcmcHeartbeatSuppressed(enabled: boolean): boolean;
        },
    };
    vi.stubGlobal('window', host);
    installDemoWorkerQualification();
    return { host, callbacks };
};
const task = (name: string) => structuredClone(fixtures.cases.find(f => f.name === name)!.task) as DemoTaskInput;
const start = (p: Port, input: DemoTaskInput, id: number) => {
    p.postMessage({ version: 1, kind: 'demo', id, input });
    p.dispatchEvent(new MessageEvent('message', { data: { version: 1, kind: 'started', id } }));
};
const finish = (p: Port, input: DemoTaskInput, id: number) =>
    p.dispatchEvent(
        new MessageEvent('message', { data: { version: 1, kind: 'demo-result', id, output: executeDemoTask(input) } }),
    );
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
it.each([false, true])(
    'cannot report one shared initial cohort across different workers, second ran model=%s',
    secondRanModel => {
        const { host } = setup();
        const a = new host.Worker();
        a.postMessage({
            version: 1,
            kind: 'calculate',
            id: 1,
            input: {
                events: [],
                weightKG: 70,
                birthYear: null,
                pkParams: null,
                labs: [],
                calibrationMethod: 'off',
                historyMode: 'forward',
                nowMs: 1700000000000,
                sampleTimesH: [],
                screen: { nowMs: 1700000000000, regimens: null },
            },
        });
        for (const [i, name] of ['intro-false-false', 'model-false-injection', 'cal-mcmc'].entries()) {
            const input = task(name);
            start(a, input, i + 2);
            finish(a, input, i + 2);
        }
        const b = new host.Worker(),
            input = task('sandbox-oral:E2');
        if (secondRanModel)
            b.postMessage({
                version: 1,
                kind: 'calculate',
                id: 8,
                input: {
                    events: [],
                    weightKG: 70,
                    birthYear: null,
                    pkParams: null,
                    labs: [],
                    calibrationMethod: 'off',
                    historyMode: 'forward',
                    nowMs: 1700000000000,
                    sampleTimesH: [],
                    screen: { nowMs: 1700000000000, regimens: null },
                },
            });
        start(b, input, 1);
        finish(b, input, 1);
        expect(host.__hrtDemoWorkerQualification.read().sharedWorker).toBe(false);
    },
);
it('includes the last timer-to-result gap in the measured renderer window', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { host, callbacks } = setup();
    const a = new host.Worker(),
        input = task('sandbox-oral:E2');
    start(a, input, 1);
    now = 5;
    callbacks[0]();
    now = 55;
    finish(a, input, 1);
    expect(host.__hrtDemoWorkerQualification.read().metrics.maxGapMs).toBe(50);
    expect(host.__hrtDemoWorkerQualification.read().metrics.roundTripMs).toBe(55);
});

it('records zero progress for MCMC even when an earlier inexpensive demo ticked', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { host, callbacks } = setup();
    const worker = new host.Worker();
    const cheap = task('model-false-injection'),
        costly = task('cal-mcmc');
    start(worker, cheap, 1);
    now = 5;
    callbacks[0]();
    now = 10;
    finish(worker, cheap, 1);
    now = 20;
    start(worker, costly, 2);
    now = 70;
    finish(worker, costly, 2);
    const report = host.__hrtDemoWorkerQualification.read();
    expect(report.metrics.ticks).toBe(1);
    expect(report.mcmcJobs).toEqual([{ ticks: 0, maxGapMs: 50, roundTripMs: 50 }]);
});
it('retains each completed MCMC heartbeat and its final gap instead of borrowing from another job', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { host, callbacks } = setup();
    const worker = new host.Worker(),
        input = task('cal-mcmc');
    start(worker, input, 1);
    now = 5;
    callbacks[0]();
    now = 55;
    finish(worker, input, 1);
    now = 60;
    start(worker, input, 2);
    now = 80;
    finish(worker, input, 2);
    expect(host.__hrtDemoWorkerQualification.read().mcmcJobs).toEqual([
        { ticks: 1, maxGapMs: 50, roundTripMs: 55 },
        { ticks: 0, maxGapMs: 20, roundTripMs: 20 },
    ]);
});
it('the targeted control suppresses only MCMC heartbeat after earlier demos have progressed', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { host, callbacks } = setup();
    const worker = new host.Worker(),
        cheap = task('model-false-injection'),
        costly = task('cal-mcmc');
    start(worker, cheap, 1);
    now = 5;
    callbacks[0]();
    now = 10;
    finish(worker, cheap, 1);
    expect(host.__hrtDemoWorkerQualification.setMcmcHeartbeatSuppressed(true)).toBe(true);
    start(worker, costly, 2);
    now = 15;
    callbacks[1]();
    now = 35;
    finish(worker, costly, 2);
    const report = host.__hrtDemoWorkerQualification.read();
    expect(report.metrics.ticks).toBe(1);
    expect(report.mcmcJobs).toEqual([{ ticks: 0, maxGapMs: 25, roundTripMs: 25 }]);
    host.__hrtDemoWorkerQualification.setMcmcHeartbeatSuppressed(false);
    start(worker, costly, 3);
    now = 40;
    callbacks[2]();
    now = 45;
    finish(worker, costly, 3);
    expect(host.__hrtDemoWorkerQualification.read().mcmcJobs[1].ticks).toBe(1);
});
