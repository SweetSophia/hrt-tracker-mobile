import { afterEach, expect, it, vi } from 'vitest';
import { EngineRunner, type EngineWorkerPort } from '../../src/application/engineRunner';
import type {
    EngineInput,
    EngineOutput,
    EngineWorkerRequest,
    EngineWorkerResponse,
} from '../../src/application/engineProtocol';
import { executeForecastTask } from '../../src/application/forecastTask';
import { forecastTaskInput } from './forecast-fixture';

const task = () => {
    const t = forecastTaskInput();
    t.request.input.events = [];
    t.request.regimens = [];
    t.request.plans = [{ id: 'synthetic-empty', spec: null }];
    return t;
};
const model = (): EngineInput => ({
    events: [],
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: 1_700_000_000_000,
    sampleTimesH: [],
});
const modelOutput = (): EngineOutput => ({
    simulation: null,
    calibration: { method: 'off', scale: 1, kMul: 1, halfLifeDeltaPct: 0, n: 0, fitErrPct: null, points: [] },
    sampleTimesH: [],
    factors: [],
    factorSDs: null,
});
class Port implements EngineWorkerPort {
    onmessage: EngineWorkerPort['onmessage'] = null;
    onerror: EngineWorkerPort['onerror'] = null;
    onmessageerror: EngineWorkerPort['onmessageerror'] = null;
    sent: EngineWorkerRequest[] = [];
    terminated = 0;
    postMessage(request: EngineWorkerRequest) {
        this.sent.push(request);
    }
    terminate() {
        this.terminated++;
    }
    result(index = 0) {
        const r = this.sent[index];
        this.onmessage?.({
            data:
                r.kind === 'forecast'
                    ? { version: 1, kind: 'forecast-result', id: r.id, output: executeForecastTask(r.input) }
                    : { version: 1, kind: 'result', id: r.id, output: modelOutput() },
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
it('serializes model and Forecast lanes on one worker without cancelling unrelated work', async () => {
    const { runner, ports } = setup();
    const first = runner.calculate(model()).catch(e => e.name);
    const captured = task();
    const forecast = runner.forecast(captured);
    captured.request.input.weight = 99;
    const newest = runner.calculate(model());
    expect(await first).toBe('AbortError');
    expect(ports[0].sent).toHaveLength(1);
    ports[0].result();
    const sent = ports[0].sent[1];
    expect(sent.kind).toBe('forecast');
    if (sent.kind !== 'forecast') throw new Error('wrong dispatch');
    expect(sent.input.request.input.weight).toBe(70);
    ports[0].result(1);
    await expect(forecast).resolves.toEqual({ current: null, results: { 'synthetic-empty': null } });
    ports[0].result(2);
    await expect(newest).resolves.toEqual(modelOutput());
    expect(ports).toHaveLength(1);
    expect(ports[0].terminated).toBe(0);
});
it('keeps only the newest Forecast in its lane while a queued model still completes', async () => {
    const { runner, ports } = setup();
    const old = runner.forecast(task()).catch(e => e.name);
    const superseded = runner.forecast(task()).catch(e => e.name);
    const shared = runner.calculate(model());
    const newest = runner.forecast(task());
    expect(await old).toBe('AbortError');
    expect(await superseded).toBe('AbortError');
    ports[0].result();
    ports[0].result(1);
    await expect(newest).resolves.toEqual({ current: null, results: { 'synthetic-empty': null } });
    ports[0].result(2);
    await expect(shared).resolves.toEqual(modelOutput());
    expect(ports).toHaveLength(1);
});
it('drops an aborted queued Forecast without interrupting the active model', async () => {
    const { runner, ports } = setup();
    const shared = runner.calculate(model());
    const abort = new AbortController();
    const forecast = runner.forecast(task(), { signal: abort.signal }).catch(e => e.name);
    abort.abort();
    expect(await forecast).toBe('AbortError');
    expect(ports[0].terminated).toBe(0);
    ports[0].result();
    await expect(shared).resolves.toEqual(modelOutput());
    expect(ports[0].sent).toHaveLength(1);
});
it('active Forecast cancellation replaces the worker and still dispatches the queued model', async () => {
    const { runner, ports } = setup();
    const abort = new AbortController();
    const forecast = runner.forecast(task(), { signal: abort.signal }).catch(e => e.name);
    const shared = runner.calculate(model());
    abort.abort();
    expect(await forecast).toBe('AbortError');
    expect(ports[0].terminated).toBe(1);
    ports[1].result();
    await expect(shared).resolves.toEqual(modelOutput());
});
it('fences Forecast replies across scope changes even when a stale worker reports a current id', async () => {
    const { runner, ports } = setup();
    const old = runner.forecast(task()).catch(e => e.name);
    const stale = ports[0].onmessage;
    runner.activate('offline/other/transmasc');
    expect(await old).toBe('AbortError');
    const current = runner.forecast(task());
    stale?.({
        data: {
            version: 1,
            kind: 'forecast-result',
            id: ports[1].sent[0].id,
            output: { current: null, results: { 'synthetic-empty': null } },
        },
    });
    expect(ports[1].terminated).toBe(0);
    ports[1].result();
    await expect(current).resolves.toEqual({ current: null, results: { 'synthetic-empty': null } });
});
it('rejects wrong-kind and incomplete Forecast results and allows a fresh retry', async () => {
    for (const kind of ['result', 'forecast-result']) {
        const { runner, ports } = setup();
        const failed = runner.forecast(task()).catch(e => e.message);
        ports[0].onmessage?.({ data: { version: 1, kind, id: ports[0].sent[0].id, output: {} } });
        expect(await failed).toBe('Model computation failed.');
        expect(ports[0].terminated).toBe(1);
        const retry = runner.forecast(task());
        ports[1].result();
        await expect(retry).resolves.toEqual({ current: null, results: { 'synthetic-empty': null } });
    }
});
it('times out a silent Forecast and recovers both task lanes', async () => {
    vi.useFakeTimers();
    const { runner, ports } = setup(50);
    const failed = runner.forecast(task()).catch(e => e.message);
    const shared = runner.calculate(model());
    ports[0].onmessage?.({ data: { version: 1, kind: 'started', id: ports[0].sent[0].id } });
    await vi.advanceTimersByTimeAsync(51);
    expect(await failed).toBe('Model computation timed out.');
    ports[1].result();
    await expect(shared).resolves.toEqual(modelOutput());
    const retry = runner.forecast(task());
    ports[1].result(1);
    await expect(retry).resolves.toEqual({ current: null, results: { 'synthetic-empty': null } });
});
it('the actual worker entry dispatches a Forecast request and returns one complete clone-safe batch', async () => {
    vi.resetModules();
    const messages: EngineWorkerResponse[] = [];
    vi.stubGlobal('onmessage', null);
    vi.stubGlobal('postMessage', (message: EngineWorkerResponse) => messages.push(message));
    await import('../../src/application/engine.worker');
    (globalThis as unknown as { onmessage(e: { data: EngineWorkerRequest }): void }).onmessage({
        data: { version: 1, kind: 'forecast', id: 1, input: task() },
    });
    expect(messages.map(m => m.kind)).toEqual(['started', 'forecast-result']);
    expect(messages[1]).toEqual({
        version: 1,
        kind: 'forecast-result',
        id: 1,
        output: { current: null, results: { 'synthetic-empty': null } },
    });
    expect(structuredClone(messages[1])).toEqual(messages[1]);
});
