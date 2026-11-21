import { afterEach, expect, it, vi } from 'vitest';
import { installLongHistoryQualification } from '../../mobile/storageQualification/longHistory';
import type { DeliveryMode } from '../../mobile/storageQualification/rendererDelivery';
import { createWebRuntime } from '../../src/application/runtime';
import { EngineRunner, type EngineWorkerPort } from '../../src/application/engineRunner';
import type { EngineInput, EngineOutput, EngineRequest } from '../../src/application/engineProtocol';
import { recordNamespace } from '../../src/records/scope';

class MemoryStorage implements Storage {
    private data = new Map<string, string>();
    get length() {
        return this.data.size;
    }
    key(index: number) {
        return [...this.data.keys()][index] ?? null;
    }
    clear() {
        this.data.clear();
    }
    getItem(key: string) {
        return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.data.set(key, value);
    }
    removeItem(key: string) {
        this.data.delete(key);
    }
}
class Port extends EventTarget implements EngineWorkerPort {
    onmessage: EngineWorkerPort['onmessage'] = null;
    onerror: EngineWorkerPort['onerror'] = null;
    onmessageerror: EngineWorkerPort['onmessageerror'] = null;
    sent: EngineRequest[] = [];
    postMessage(request: EngineRequest) {
        this.sent.push(request);
    }
    terminate() {}
    emit(kind: string, output?: EngineOutput, version = 1) {
        const data = { version, kind, id: this.sent.at(-1)!.id, output };
        this.dispatchEvent(new MessageEvent('message', { data }));
    }
    dispatchEvent(event: Event) {
        const dispatched = super.dispatchEvent(event);
        if (event.type === 'message') this.onmessage?.(event as MessageEvent);
        return dispatched;
    }
}
type Trace = { phase: string; attempts: number; discardedAttempts: number; metrics: unknown };
type Api = { start(mode?: DeliveryMode): Promise<boolean>; read(): Trace; stop(): void };
const runners: EngineRunner[] = [];
const originalComplete = Reflect.get(EngineRunner.prototype, 'complete');
// The real runner still validates this small transport result; no heavy numerical work is mocked inside it.
const output = (input: EngineInput): EngineOutput => {
    const screenTimes = [
        ...new Set([
            ...input.sampleTimesH,
            ...input.events.map(event => event.timeH),
            ...input.labs.map(lab => lab.timeH),
        ]),
    ];
    return {
        simulation: {
            timeH: input.sampleTimesH,
            concPGmL: [1],
            concPGmL_E2: [1],
            concPGmL_CPA: [0],
            concPGmL_BICA: [0],
            concNGdL_T: [0],
            auc: 0,
        },
        calibration: { method: 'mcmc', scale: 1, kMul: 1, halfLifeDeltaPct: 0, n: 0, fitErrPct: null, points: [] },
        sampleTimesH: input.sampleTimesH,
        factors: [1],
        factorSDs: null,
        screen: {
            nowMs: input.nowMs,
            simulationAhead: null,
            sampleTimesH: screenTimes,
            factors: screenTimes.map(() => 1),
            factorSDs: null,
        },
    };
};
const setup = async (profile = false) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const chart = { getClientRects: () => [{}], closest: () => null, getAttribute: () => 'M0 0 L100 100' };
    vi.stubGlobal('document', {
        querySelectorAll: (selector: string) => (selector.startsWith('.main-view') ? [chart] : []),
    });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    const transport = { failNextConstruction: false };
    const workers: Port[] = [];
    const host = {
        Worker: class extends Port {
            constructor() {
                super();
                if (transport.failNextConstruction) {
                    transport.failNextConstruction = false;
                    throw new Error('Synthetic worker construction failure.');
                }
                workers.push(this);
            }
        },
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
        cancelAnimationFrame: clearTimeout,
        __hrtLongHistoryQualification: undefined as unknown as Api,
        __hrtRendererProfileArmed: profile,
    };
    vi.stubGlobal('window', host);
    const runtime = await createWebRuntime(new MemoryStorage(), 'offline');
    installLongHistoryQualification(runtime);
    const ports: Port[] = [];
    const runner = new EngineRunner(() => {
        const port = new host.Worker();
        ports.push(port);
        return port;
    });
    runners.push(runner);
    runner.activate('offline/local/transfem');
    const start = async (mode?: DeliveryMode) => {
        await host.__hrtLongHistoryQualification.start(mode);
        const state = runtime.controller.getState();
        if (state.status !== 'ready') throw new Error('Expected acknowledged records.');
        const entries = state.snapshots[recordNamespace(state.scope)].entries;
        const nowMs = Date.now();
        const input: EngineInput = {
            events: JSON.parse(entries['hrt-events']),
            labs: JSON.parse(entries['hrt-lab-results']),
            weightKG: 70,
            birthYear: null,
            pkParams: null,
            calibrationMethod: 'mcmc',
            historyMode: 'forward',
            nowMs,
            sampleTimesH: [nowMs / 3_600_000],
            screen: { nowMs, regimens: null },
        };
        const calculate = (signal?: AbortSignal) => runner.calculate(input, { signal });
        const succeed = () => {
            const port = ports.at(-1)!;
            port.emit('started');
            setTimeout(() => port.emit('result', output(input)), 10);
        };
        return { input, calculate, succeed };
    };
    return { api: host.__hrtLongHistoryQualification, ports, workers, start, transport, runner };
};
afterEach(() => {
    runners.splice(0).forEach(runner => runner.dispose());
    Reflect.set(EngineRunner.prototype, 'complete', originalComplete);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
it('keeps an aged-hook timeout terminal after a successful minute-clock replacement', async () => {
    const { api, ports, start } = await setup();
    const clock = { refresh: undefined as (() => void) | undefined };
    const minute = setInterval(() => clock.refresh?.(), 60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    const { calculate, succeed } = await start();
    const first = calculate().catch(error => error.message);
    ports[0].emit('started');
    let replacement: Promise<unknown> | undefined;
    clock.refresh = () => {
        replacement = calculate();
        succeed();
    };
    await vi.advanceTimersByTimeAsync(40_050);
    expect(await first).toBe('Model computation timed out.');
    await expect(replacement).resolves.toMatchObject({ calibration: { method: 'mcmc' } });
    expect(api.read()).toMatchObject({ phase: 'failed', discardedAttempts: 0, metrics: null });
    clearInterval(minute);
});
it.each(['invalid-output', 'invalid-version'])('does not forgive %s when a later request succeeds', async failure => {
    const { api, ports, start } = await setup();
    const { calculate, succeed } = await start();
    const first = calculate().catch(error => error.message);
    ports[0].emit('started');
    ports[0].emit(
        'result',
        failure === 'invalid-output'
            ? { ...output(ports[0].sent[0].input), factors: [NaN] }
            : output(ports[0].sent[0].input),
        failure === 'invalid-version' ? 2 : 1,
    );
    expect(await first).toBe('Model computation failed.');
    const next = calculate();
    succeed();
    await vi.advanceTimersByTimeAsync(40);
    await expect(next).resolves.toMatchObject({ calibration: { method: 'mcmc' } });
    expect(api.read()).toMatchObject({ phase: 'failed', discardedAttempts: 0, metrics: null });
});
it('preserves a confirmed active abort followed synchronously by the clock-catch-up calculation', async () => {
    const { api, ports, start } = await setup();
    const { calculate, succeed } = await start();
    const abort = new AbortController();
    const first = calculate(abort.signal).catch(error => error.name);
    ports[0].emit('started');
    abort.abort();
    const next = calculate();
    succeed();
    expect(await first).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(40);
    await expect(next).resolves.toMatchObject({ calibration: { method: 'mcmc' } });
    expect(api.read()).toMatchObject({ phase: 'complete', attempts: 2, discardedAttempts: 1 });
});
it('rejects an unexplained terminate instead of treating it as an explicit abort', async () => {
    const { api, ports, start } = await setup();
    const { calculate } = await start();
    void calculate().catch(() => {});
    ports[0].emit('started');
    ports[0].terminate();
    expect(api.read()).toMatchObject({ phase: 'failed', discardedAttempts: 0, metrics: null });
});

it('keeps a measured worker-construction failure terminal before the first post', async () => {
    const { api, start, transport } = await setup();
    const { calculate, succeed } = await start();
    transport.failNextConstruction = true;
    await expect(calculate()).rejects.toThrow('Model computation failed.');
    const next = calculate();
    succeed();
    await vi.advanceTimersByTimeAsync(40);
    await expect(next).resolves.toMatchObject({ calibration: { method: 'mcmc' } });
    expect(api.read()).toMatchObject({ phase: 'failed', attempts: 0, discardedAttempts: 0, metrics: null });
});

it('does not classify an unmarked calculation failure as the measured pre-post failure', async () => {
    const { api, start, transport, runner } = await setup();
    const { input, calculate, succeed } = await start();
    transport.failNextConstruction = true;
    await expect(runner.calculate({ ...input, events: [] })).rejects.toThrow('Model computation failed.');
    expect(api.read()).toMatchObject({ phase: 'preparing', attempts: 0 });
    const next = calculate();
    succeed();
    await vi.advanceTimersByTimeAsync(40);
    await expect(next).resolves.toMatchObject({ calibration: { method: 'mcmc' } });
    expect(api.read()).toMatchObject({ phase: 'complete', attempts: 1, discardedAttempts: 0 });
});

it('marks only the admitted action and accepted worker lifecycle through the final frame', async () => {
    const { api, ports, start } = await setup(true);
    const marks = vi.spyOn(performance, 'mark');
    const { calculate, succeed } = await start();
    const abort = new AbortController();
    const first = calculate(abort.signal).catch(error => error.name);
    ports[0].emit('started');
    abort.abort();
    const next = calculate();
    succeed();
    await vi.advanceTimersByTimeAsync(40);
    await next;
    expect(await first).toBe('AbortError');
    expect(api.read()).toMatchObject({ phase: 'complete', attempts: 2, discardedAttempts: 1 });
    expect(marks.mock.calls.map(([name]) => name)).toEqual([
        'hrt.renderer.action.0.0',
        'hrt.renderer.post.1.1',
        'hrt.renderer.started.1.1',
        'hrt.renderer.cancel.1.1',
        'hrt.renderer.post.2.2',
        'hrt.renderer.started.2.2',
        'hrt.renderer.result.2.2',
        'hrt.renderer.frame.2.2',
    ]);
    expect(marks.mock.calls.map(([, options]) => options?.startTime)).toEqual([0, 0, 0, 0, 0, 0, 10, 32]);
});

async function compare(mode: DeliveryMode, createOutput = output) {
    const { api, start, ports, workers } = await setup(true);
    const marks = vi.spyOn(performance, 'mark');
    const { input, calculate } = await start(mode);
    const result = calculate();
    void result.catch(() => undefined);
    expect(ports[0].sent).toHaveLength(0);
    expect(workers).toHaveLength(2);
    const comparison = workers[1];
    const prepare = comparison.sent[0] as unknown as { request: EngineRequest };
    const { id } = prepare.request;
    const staged = createOutput(input);
    const emit = (data: object) => comparison.dispatchEvent(new MessageEvent('message', { data: { id, ...data } }));
    emit({ kind: 'started', version: 1 });
    emit({ kind: 'prepared', output: staged });
    await vi.advanceTimersByTimeAsync(35);
    expect(comparison.sent.at(-1)).toEqual({ kind: 'release', id, mode });
    const delivered = mode === 'worker' ? structuredClone(staged) : staged;
    emit({ kind: 'delivery', mode, ...(mode === 'worker' ? { output: delivered } : {}) });
    return { result, delivered, api, marks, id };
}

it.each(['worker', 'preloaded'] as const)(
    'routes the %s comparison through the real runner and presentation',
    async mode => {
        const { result, delivered, api, marks, id } = await compare(mode);
        await expect(result).resolves.toBe(delivered);
        await vi.advanceTimersByTimeAsync(48);
        expect(api.read()).toMatchObject({ phase: 'complete', attempts: 1 });
        expect(marks.mock.calls.map(([name]) => name)).toEqual([
            'hrt.renderer.action.0.0',
            'hrt.renderer.post.1.' + id,
            'hrt.renderer.started.1.' + id,
            'hrt.renderer.delivery-release.1.' + id,
            'hrt.renderer.delivery-callback.1.' + id,
            'hrt.renderer.delivery-read.1.' + id,
            'hrt.renderer.result.1.' + id,
            'hrt.renderer.delivery-accept.1.' + id,
            'hrt.renderer.frame.1.' + id,
        ]);
    },
);

it('lets the same runner validator reject an invalid preloaded result', async () => {
    const { result, api, marks, id } = await compare('preloaded', input => ({ ...output(input), factors: [NaN] }));
    await expect(result).rejects.toThrow('Model computation failed.');
    await vi.advanceTimersByTimeAsync(48);
    expect(api.read()).toMatchObject({ phase: 'failed', metrics: null });
    expect(marks.mock.calls.map(([name]) => name)).not.toContain('hrt.renderer.delivery-accept.1.' + id);
});

it.each(['worker error', 'probe stop'])(
    'settles the active comparison and dispatches queued work after %s',
    async failure => {
        const { api, start, ports, workers, runner } = await setup(true);
        const { input, calculate } = await start('preloaded');
        let rejected: string | undefined;
        void calculate().catch(error => {
            rejected = error.message;
        });
        const queued = runner.demo({
            request: { kind: 'onboarding', isTransmasc: false, anchorMs: input.nowMs },
            nowMs: input.nowMs,
            pkParams: null,
        });
        void queued.catch(() => undefined);

        const comparison = workers[1];
        const { request } = comparison.sent[0] as unknown as { request: EngineRequest };
        expect(ports).toHaveLength(1);
        if (failure === 'worker error') {
            comparison.dispatchEvent(
                new MessageEvent('message', {
                    data: { kind: 'error', id: request.id, version: request.version },
                }),
            );
        } else {
            api.stop();
            api.stop();
        }
        await Promise.resolve();
        expect(rejected).toBe('Model computation failed.');
        expect(api.read()).toMatchObject({ phase: 'failed', metrics: null });
        expect(ports).toHaveLength(2);
        expect(ports[1].sent).toHaveLength(1);
        expect(ports[1].sent[0]).toMatchObject({ kind: 'demo', id: request.id + 1 });
        ports[1].dispatchEvent(
            new MessageEvent('message', {
                data: {
                    kind: 'demo-result',
                    id: request.id + 1,
                    version: 1,
                    output: { kind: 'onboarding', value: null },
                },
            }),
        );
        await expect(queued).resolves.toEqual({ kind: 'onboarding', value: null });
    },
);
