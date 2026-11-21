import { afterEach, expect, it, vi } from 'vitest';
import { EngineRunner, type EngineWorkerPort } from '../../src/application/engineRunner';
import type { EngineInput, EngineWorkerRequest, EngineWorkerResponse } from '../../src/application/engineProtocol';
import type { DemoTaskInput } from '../../src/application/demoProtocol';
import { executeDemoTask } from '../../src/application/demoTask';
import { executeForecastTask } from '../../src/application/forecastTask';
import { forecastTaskInput } from './forecast-fixture';
const demo = (): DemoTaskInput => ({
    request: { kind: 'sandbox', modelId: 'oral:E2', inputs: { doseMG: 2, bodyWeightKG: 70, birthYear: null } },
    nowMs: 1700000000000,
    pkParams: null,
});
const model = (): EngineInput => ({
    events: [],
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: 1700000000000,
    sampleTimesH: [],
});
const modelOutput = () => ({
    simulation: null,
    calibration: { method: 'off', scale: 1, kMul: 1, halfLifeDeltaPct: 0, n: 0, fitErrPct: null, points: [] },
    sampleTimesH: [],
    factors: [],
    factorSDs: null,
});
const forecast = () => {
    const t = forecastTaskInput();
    t.request.input.events = [];
    t.request.regimens = [];
    t.request.plans = [];
    return t;
};
class Port implements EngineWorkerPort {
    onmessage: EngineWorkerPort['onmessage'] = null;
    onerror: EngineWorkerPort['onerror'] = null;
    onmessageerror: EngineWorkerPort['onmessageerror'] = null;
    sent: EngineWorkerRequest[] = [];
    terminated = 0;
    postMessage(r: EngineWorkerRequest) {
        this.sent.push(r);
    }
    terminate() {
        this.terminated++;
    }
    result(i = 0) {
        const r = this.sent[i];
        this.onmessage?.({
            data: {
                version: 1,
                id: r.id,
                kind: r.kind === 'demo' ? 'demo-result' : r.kind === 'forecast' ? 'forecast-result' : 'result',
                output:
                    r.kind === 'demo'
                        ? executeDemoTask(r.input)
                        : r.kind === 'forecast'
                          ? executeForecastTask(r.input)
                          : modelOutput(),
            },
        });
    }
}
const runners: EngineRunner[] = [];
const setup = (timeout = 1000) => {
    const ports: Port[] = [];
    const runner = new EngineRunner(() => {
        const p = new Port();
        ports.push(p);
        return p;
    }, timeout);
    runner.activate('offline/local/transfem');
    runners.push(runner);
    return { runner, ports };
};
afterEach(() => {
    for (const r of runners.splice(0)) r.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('serializes all three kinds on one worker and captures demo edits', async () => {
    const { runner, ports } = setup();
    const a = runner.calculate(model());
    const input = demo();
    const b = runner.demo(input);
    if (input.request.kind === 'sandbox') input.request.inputs.doseMG = 99;
    const c = runner.forecast(forecast());
    expect(ports[0].sent).toHaveLength(1);
    ports[0].result();
    await expect(a).resolves.toMatchObject({ simulation: null });
    const sent = ports[0].sent[1];
    expect(sent.kind).toBe('demo');
    if (sent.kind === 'demo' && sent.input.request.kind === 'sandbox') expect(sent.input.request.inputs.doseMG).toBe(2);
    ports[0].result(1);
    await expect(b).resolves.toEqual(executeDemoTask(demo()));
    ports[0].result(2);
    await expect(c).resolves.toEqual({ current: null, results: {} });
    expect(ports).toHaveLength(1);
});
it('supersedes only demo jobs while both other kinds remain queued', async () => {
    const { runner, ports } = setup();
    const old = runner.demo(demo()).catch(e => e.name);
    const pending = runner.demo(demo()).catch(e => e.name);
    const a = runner.calculate(model());
    const b = runner.forecast(forecast());
    const newest = runner.demo(demo());
    expect(await old).toBe('AbortError');
    expect(await pending).toBe('AbortError');
    ports[0].result();
    ports[0].result(1);
    await expect(newest).resolves.toEqual(executeDemoTask(demo()));
    ports[0].result(2);
    await a;
    ports[0].result(3);
    await b;
    expect(ports).toHaveLength(1);
});
it('drops a queued aborted demo without interrupting its model', async () => {
    const { runner, ports } = setup();
    const a = runner.calculate(model());
    const abort = new AbortController();
    const b = runner.demo(demo(), { signal: abort.signal }).catch(e => e.name);
    abort.abort();
    expect(await b).toBe('AbortError');
    expect(ports[0].terminated).toBe(0);
    ports[0].result();
    await a;
    expect(ports[0].sent).toHaveLength(1);
});
it('active demo abort replaces its worker and preserves both other lanes', async () => {
    const { runner, ports } = setup();
    const abort = new AbortController();
    const d = runner.demo(demo(), { signal: abort.signal }).catch(e => e.name);
    const a = runner.calculate(model());
    const b = runner.forecast(forecast());
    abort.abort();
    expect(await d).toBe('AbortError');
    expect(ports[0].terminated).toBe(1);
    ports[1].result();
    await a;
    ports[1].result(1);
    await b;
});
it('times out a silent demo and recovers all kinds', async () => {
    vi.useFakeTimers();
    const { runner, ports } = setup(50);
    const d = runner.demo(demo()).catch(e => e.message);
    const a = runner.calculate(model());
    const b = runner.forecast(forecast());
    await vi.advanceTimersByTimeAsync(51);
    expect(await d).toBe('Model computation timed out.');
    ports[1].result();
    await a;
    ports[1].result(1);
    await b;
    const retry = runner.demo(demo());
    ports[1].result(2);
    await expect(retry).resolves.toEqual(executeDemoTask(demo()));
});
it('rejects wrong-kind and partial demo replies and permits a fresh retry', async () => {
    for (const kind of ['forecast-result', 'demo-result']) {
        const { runner, ports } = setup();
        const failed = runner.demo(demo()).catch(e => e.message);
        ports[0].onmessage?.({
            data: { version: 1, kind, id: ports[0].sent[0].id, output: { kind: 'sandbox', value: {} } },
        });
        expect(await failed).toBe('Model computation failed.');
        expect(ports[0].terminated).toBe(1);
        const retry = runner.demo(demo());
        ports[1].result();
        await expect(retry).resolves.toEqual(executeDemoTask(demo()));
    }
});
it('rejects a former-scope demo response even with the new job id', async () => {
    const { runner, ports } = setup();
    const old = runner.demo(demo()).catch(e => e.name);
    const stale = ports[0].onmessage;
    runner.activate('offline/local/transmasc');
    expect(await old).toBe('AbortError');
    const current = runner.demo(demo());
    stale?.({ data: { version: 1, kind: 'demo-result', id: ports[1].sent[0].id, output: executeDemoTask(demo()) } });
    expect(ports[1].terminated).toBe(0);
    ports[1].result();
    await expect(current).resolves.toEqual(executeDemoTask(demo()));
});
it('executes the actual worker demo entry with cloneable output', async () => {
    vi.resetModules();
    const messages: EngineWorkerResponse[] = [];
    vi.stubGlobal('onmessage', null);
    vi.stubGlobal('postMessage', (m: EngineWorkerResponse) => messages.push(m));
    await import('../../src/application/engine.worker');
    (globalThis as unknown as { onmessage(e: { data: unknown }): void }).onmessage({
        data: { version: 1, kind: 'demo', id: 1, input: demo() },
    });
    expect(messages.map(m => m.kind)).toEqual(['started', 'demo-result']);
    expect(messages[1]).toEqual({ version: 1, kind: 'demo-result', id: 1, output: executeDemoTask(demo()) });
    expect(structuredClone(messages[1])).toStrictEqual(messages[1]);
});
