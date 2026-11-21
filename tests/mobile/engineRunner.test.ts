import { afterEach, expect, it, vi } from 'vitest';
import { EngineRunner, type EngineWorkerPort } from '../../src/application/engineRunner';
import type { EngineInput, EngineOutput, EngineRequest } from '../../src/application/engineProtocol';

const input = (): EngineInput => ({
    events: [],
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: 1_700_000_000_000,
    sampleTimesH: [1, 2],
});
const output = (): EngineOutput => ({
    simulation: null,
    calibration: { method: 'off', scale: 1, kMul: 1, halfLifeDeltaPct: 0, n: 0, fitErrPct: null, points: [] },
    sampleTimesH: [1, 2],
    factors: [1, 1],
    factorSDs: null,
});
class Port implements EngineWorkerPort {
    onmessage: EngineWorkerPort['onmessage'] = null;
    onerror: EngineWorkerPort['onerror'] = null;
    onmessageerror: EngineWorkerPort['onmessageerror'] = null;
    sent: EngineRequest[] = [];
    terminated = 0;
    throwOnPost = false;
    postMessage(request: EngineRequest) {
        if (this.throwOnPost) throw new Error('synthetic private input');
        this.sent.push(request);
    }
    terminate() {
        this.terminated++;
    }
    result(index = 0, value = output()) {
        this.onmessage?.({ data: { version: 1, kind: 'result', id: this.sent[index].id, output: value } });
    }
}
const setup = (timeout = 1000) => {
    const ports: Port[] = [];
    const runner = new EngineRunner(() => {
        const p = new Port();
        ports.push(p);
        return p;
    }, timeout);
    runner.activate('offline/local/transfem');
    return { runner, ports };
};
afterEach(() => vi.useRealTimers());
it('serializes jobs, rejects obsolete promises and keeps only the latest captured request', async () => {
    const { runner, ports } = setup();
    const first = runner.calculate(input()).catch(e => e.name);
    const second = runner.calculate(input()).catch(e => e.name);
    const captured = input();
    const third = runner.calculate(captured);
    captured.sampleTimesH[0] = 999;
    expect(await first).toBe('AbortError');
    expect(await second).toBe('AbortError');
    expect(ports[0].sent).toHaveLength(1);
    ports[0].result();
    expect(ports[0].sent).toHaveLength(2);
    expect(ports[0].sent[1].input.sampleTimesH).toEqual([1, 2]);
    ports[0].result(1);
    expect(await third).toEqual(output());
    expect(ports[0].terminated).toBe(0);
    runner.dispose();
});
it('fences late replies and errors from a terminated scope even with a current request id', async () => {
    const { runner, ports } = setup();
    const old = runner.calculate(input()).catch(e => e.name);
    const staleMessage = ports[0].onmessage,
        staleError = ports[0].onerror;
    runner.activate('offline/other/transmasc');
    expect(await old).toBe('AbortError');
    expect(ports[0].terminated).toBe(1);
    const next = runner.calculate(input());
    const id = ports[1].sent[0].id;
    staleMessage?.({ data: { version: 1, kind: 'result', id, output: output() } });
    staleError?.({});
    expect(ports[1].terminated).toBe(0);
    ports[1].onmessage?.({ data: { version: 1, kind: 'result', id: id + 100, output: output() } });
    expect(ports[1].sent).toHaveLength(1);
    ports[1].result();
    expect(await next).toEqual(output());
    runner.dispose();
});
it('aborts an active computation by terminating its worker and can start again', async () => {
    const { runner, ports } = setup();
    const controller = new AbortController();
    const job = runner.calculate(input(), { signal: controller.signal }).catch(e => e.name);
    controller.abort();
    expect(await job).toBe('AbortError');
    expect(ports[0].terminated).toBe(1);
    const next = runner.calculate(input());
    ports[1].result();
    await expect(next).resolves.toEqual(output());
    runner.dispose();
});
it('drops an aborted queued request without terminating an unrelated active task', async () => {
    const { runner, ports } = setup();
    const first = runner.calculate(input()).catch(e => e.name);
    const controller = new AbortController();
    const queued = runner.calculate(input(), { signal: controller.signal }).catch(e => e.name);
    controller.abort();
    expect(await queued).toBe('AbortError');
    expect(await first).toBe('AbortError');
    expect(ports[0].terminated).toBe(0);
    ports[0].result();
    expect(ports[0].sent).toHaveLength(1);
    runner.dispose();
});
it('times out a silent worker, including one that only sends started', async () => {
    vi.useFakeTimers();
    const { runner, ports } = setup(50);
    const job = runner.calculate(input()).catch(e => e.message);
    ports[0].onmessage?.({ data: { version: 1, kind: 'started', id: ports[0].sent[0].id } });
    await vi.advanceTimersByTimeAsync(51);
    expect(await job).toBe('Model computation timed out.');
    expect(ports[0].terminated).toBe(1);
    runner.dispose();
});
it('rejects incomplete results, worker failures and post failures without exposing their details', async () => {
    for (const failure of ['missing', 'times', 'factors', 'error', 'messageerror', 'post', 'remote']) {
        const ports: Port[] = [];
        const runner = new EngineRunner(() => {
            const p = new Port();
            p.throwOnPost = failure === 'post';
            ports.push(p);
            return p;
        });
        runner.activate('scope');
        const job = runner.calculate(input()).catch(e => e.message);
        const p = ports[0];
        if (failure === 'error') p.onerror?.({});
        else if (failure === 'messageerror') p.onmessageerror?.({});
        else if (failure === 'remote') p.onmessage?.({ data: { version: 1, kind: 'error', id: p.sent[0].id } });
        else if (failure !== 'post') {
            const result = output();
            if (failure === 'times') result.sampleTimesH = [2, 1];
            if (failure === 'factors') result.factors = [NaN, 1];
            p.onmessage?.({
                data: { version: 1, kind: 'result', id: p.sent[0].id, output: failure === 'missing' ? {} : result },
            });
        }
        expect(await job, failure).toBe('Model computation failed.');
        expect(p.terminated).toBe(1);
        runner.dispose();
    }
});
it('rejects invalid lifecycle use, already-aborted signals and use after dispose', async () => {
    const runner = new EngineRunner(() => new Port());
    await expect(runner.calculate(input())).rejects.toThrow('No active model context.');
    runner.activate('scope');
    const c = new AbortController();
    c.abort();
    await expect(runner.calculate(input(), { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    runner.dispose();
    await expect(runner.calculate(input())).rejects.toThrow('Model runner is disposed.');
    expect(() => runner.activate('new')).toThrow('Model runner is disposed.');
});

it('disposes active and queued work without publishing a late reply', async () => {
    const { runner, ports } = setup();
    const first = runner.calculate(input()).catch(error => error.name);
    const late = ports[0].onmessage;
    const queued = runner.calculate(input()).catch(error => error.name);
    runner.dispose();
    expect(await first).toBe('AbortError');
    expect(await queued).toBe('AbortError');
    expect(ports[0].terminated).toBe(1);
    late?.({ data: { version: 1, kind: 'result', id: ports[0].sent[0].id, output: output() } });
    expect(ports[0].sent).toHaveLength(1);
});

it('recovers the newest queued job after its obsolete predecessor times out', async () => {
    vi.useFakeTimers();
    const { runner, ports } = setup(50);
    const first = runner.calculate(input()).catch(error => error.name);
    const queued = runner.calculate(input());
    expect(await first).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(51);
    expect(ports[0].terminated).toBe(1);
    expect(ports).toHaveLength(2);
    ports[1].result();
    await expect(queued).resolves.toEqual(output());
    runner.dispose();
});

it('requires a complete exact screen table, a matching clock and valid prediction arrays', async () => {
    const request = { ...input(), screen: { nowMs: 1_700_000_000_000, regimens: null } };
    const good = (): EngineOutput => ({
        ...output(),
        screen: {
            nowMs: request.screen.nowMs,
            simulationAhead: null,
            sampleTimesH: [1, 2, request.screen.nowMs / 3_600_000],
            factors: [1, 1, 1],
            factorSDs: null,
        },
    });
    for (const mutate of [
        (value: EngineOutput) => {
            delete value.screen;
        },
        (value: EngineOutput) => {
            value.screen!.nowMs += 60_000;
        },
        (value: EngineOutput) => {
            value.screen!.sampleTimesH.pop();
            value.screen!.factors.pop();
        },
        (value: EngineOutput) => {
            value.screen!.factors[0] = NaN;
        },
        (value: EngineOutput) => {
            value.screen!.simulationAhead = { timeH: [1] } as never;
        },
    ]) {
        const { runner, ports } = setup();
        const result = runner.calculate(request).catch(error => error.message);
        const invalid = good();
        mutate(invalid);
        ports[0].result(0, invalid);
        expect(await result).toBe('Model computation failed.');
        runner.dispose();
    }
    const { runner, ports } = setup();
    const result = runner.calculate(request);
    ports[0].result(0, good());
    expect(await result).toEqual(good());
    runner.dispose();
});
