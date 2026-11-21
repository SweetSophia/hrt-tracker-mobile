import { afterEach, expect, it, vi } from 'vitest';
import type { ApplicationRuntime } from '../../src/application/runtime';
import { installAppEngineWorkerQualification } from '../../mobile/storageQualification/appEngineWorker';
import { executeEngineTask } from '../../src/application/engineTask';
import type { EngineInput } from '../../src/application/engineProtocol';
class Port extends EventTarget {
    postMessage(_request: unknown) {}
    terminate() {}
}
const input: EngineInput = {
    events: [],
    labs: [],
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: 1_800_000_000_000,
    sampleTimesH: [],
    screen: { nowMs: 1_800_000_000_000, regimens: null },
};
const setup = (observe?: () => boolean) => {
    const output = executeEngineTask(input),
        callbacks: (() => void)[] = [];
    const host = {
        Worker: Port,
        setInterval: (fn: () => void) => callbacks.push(fn),
        clearInterval: () => {},
        __hrtAppEngineWorkerQualification: undefined as unknown as {
            read(): {
                metrics: { requests: number; results: number; ticks: number };
                last: { baselineHash: string; samplesCovered: boolean };
            };
        },
    };
    vi.stubGlobal('window', host);
    installAppEngineWorkerQualification({} as ApplicationRuntime, observe);
    return { host, output, callbacks, worker: new host.Worker() };
};
afterEach(() => vi.unstubAllGlobals());
it('preserves the default ordinary-screen parity observation and hashing', async () => {
    const { host, worker, output } = setup();
    worker.postMessage({ version: 1, kind: 'calculate', id: 1, input });
    worker.dispatchEvent(new MessageEvent('message', { data: { version: 1, kind: 'result', id: 1, output } }));
    await vi.waitFor(() => expect(host.__hrtAppEngineWorkerQualification.read().last.baselineHash).toHaveLength(64));
    expect(host.__hrtAppEngineWorkerQualification.read()).toMatchObject({
        metrics: { requests: 1, results: 1 },
        last: { samplesCovered: true },
    });
});
it('does not inspect large output or count its own timers while observation is suspended', () => {
    let enabled = true,
        reads = 0;
    const { host, worker, output, callbacks } = setup(() => enabled);
    worker.postMessage({ version: 1, kind: 'calculate', id: 1, input: { ...input, calibrationMethod: 'mcmc' } });
    worker.dispatchEvent(new MessageEvent('message', { data: { version: 1, kind: 'started', id: 1 } }));
    enabled = false;
    Object.defineProperty(output, 'simulation', {
        get() {
            reads++;
            return null;
        },
    });
    callbacks[0]();
    worker.dispatchEvent(new MessageEvent('message', { data: { version: 1, kind: 'result', id: 1, output } }));
    expect(reads).toBe(0);
    expect(host.__hrtAppEngineWorkerQualification.read().metrics).toMatchObject({ requests: 1, results: 0, ticks: 0 });
    worker.postMessage({ version: 1, kind: 'calculate', id: 2, input });
    worker.dispatchEvent(new MessageEvent('message', { data: { version: 1, kind: 'result', id: 2, output } }));
    expect(reads).toBe(0);
    expect(host.__hrtAppEngineWorkerQualification.read().metrics.requests).toBe(1);
});
