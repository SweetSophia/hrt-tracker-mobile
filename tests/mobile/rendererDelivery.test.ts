import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { startRendererDelivery, type DeliveryMode } from '../../mobile/storageQualification/rendererDelivery';
import { executeEngineTask } from '../../src/application/engineTask';
import type { EngineRequest } from '../../src/application/engineProtocol';

const request: EngineRequest = {
    kind: 'calculate',
    id: 17,
    version: 1,
    input: {
        events: [],
        labs: [],
        weightKG: 70,
        birthYear: null,
        pkParams: null,
        calibrationMethod: 'mcmc',
        historyMode: 'forward',
        nowMs: 1_700_000_000_000,
        sampleTimesH: [],
    },
};
const output = executeEngineTask(request.input);

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function attempt(mode: DeliveryMode) {
    let now = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('window', {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    const port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        onmessageerror: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
    };
    const mark = vi.fn(),
        deliver = vi.fn(),
        failed = vi.fn();
    const delivery = startRendererDelivery(port, request, mode, { mark, deliver, failed });
    const emit = (data: unknown, at: number, readAt = at) => {
        now = at;
        port.onmessage?.({
            get data() {
                now = readAt;
                return data;
            },
        } as MessageEvent);
    };
    const prime = () => {
        emit({ kind: 'started', version: 1, id: request.id }, 1);
        emit({ kind: 'prepared', id: request.id, output }, 5);
    };
    const frame = (at: number) => {
        now = at;
        for (const [id, callback] of [...frames]) {
            frames.delete(id);
            callback(now);
        }
    };
    return { port, mark, deliver, failed, delivery, emit, prime, frame, frames };
}

it.each(['worker', 'preloaded'] as const)(
    'observes %s delivery after the equal warm-up and through acceptance',
    async mode => {
        const { port, mark, deliver, failed, delivery, emit, prime, frame } = attempt(mode);
        expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'prepare', request });
        prime();
        frame(8);
        expect(port.postMessage).toHaveBeenCalledTimes(1);
        frame(10);
        expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'release', id: request.id, mode });
        const result = mode === 'worker' ? structuredClone(output) : output;
        const reply = { kind: 'delivery', id: request.id, mode, ...(mode === 'worker' ? { output: result } : {}) };
        emit(reply, 15, 23);
        expect(deliver).toHaveBeenLastCalledWith({ kind: 'result', id: request.id, version: 1, output: result });
        expect(deliver.mock.lastCall?.[0].output).toBe(result);
        expect(delivery.accept({}, 24)).toBe(false);
        expect(delivery.accept(result, 27)).toBe(true);
        delivery.stop();
        expect(deliver.mock.calls.map(([response]) => response.kind)).toEqual(['started', 'result']);
        await expect(delivery.report(41)).resolves.toEqual({
            mode,
            sameOutput: true,
            outputBytes: Buffer.byteLength(JSON.stringify(output)),
            replyBytes: Buffer.byteLength(JSON.stringify(reply)),
            metrics: {
                releaseToCallbackMs: 5,
                callbackToReadMs: 8,
                readToAcceptedMs: 4,
                acceptedToFrameMs: 14,
                releaseToFrameMs: 31,
            },
        });
        expect(mark.mock.calls).toEqual([
            ['delivery-release', 10],
            ['delivery-callback', 15],
            ['delivery-read', 23],
            ['delivery-accept', 27],
        ]);
        expect(failed).not.toHaveBeenCalled();
        expect(port.terminate).toHaveBeenCalledTimes(1);
    },
);

it('cancels the scheduled release and terminates its worker when an attempt is discarded', async () => {
    const { port, delivery, frames, frame, prime } = attempt('preloaded');
    prime();
    frame(8);
    delivery.close();
    delivery.close();
    expect(frames.size).toBe(0);
    frame(10);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.onmessage).toBeNull();
    expect(port.terminate).toHaveBeenCalledTimes(1);
    await expect(delivery.report(41)).rejects.toThrow('Incomplete renderer delivery');
});

it('rejects a result for a different request without forwarding it', () => {
    const { port, failed, deliver, emit, prime, frame } = attempt('worker');
    prime();
    frame(8);
    frame(10);
    emit({ kind: 'delivery', id: request.id + 1, mode: 'worker', output }, 15);
    expect(failed).toHaveBeenCalledExactlyOnceWith();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith({ kind: 'error', id: request.id, version: request.version });
    expect(failed.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[1]);
    expect(port.terminate).toHaveBeenCalledTimes(1);
});

it('requires the delivered output to match the preloaded copy', async () => {
    const { delivery, emit, prime, frame } = attempt('worker');
    prime();
    frame(8);
    frame(10);
    const different = { ...output, factors: [123] };
    emit({ kind: 'delivery', id: request.id, mode: 'worker', output: different }, 15);
    expect(delivery.accept(different, 20)).toBe(true);
    await expect(delivery.report(30)).rejects.toThrow('Renderer delivery output changed');
});

it('refuses to certify a preloaded reply that includes the output', async () => {
    const { delivery, emit, prime, frame } = attempt('preloaded');
    prime();
    frame(8);
    frame(10);
    emit({ kind: 'delivery', id: request.id, mode: 'preloaded', output }, 15);
    expect(delivery.accept(output, 20)).toBe(true);
    await expect(delivery.report(30)).rejects.toThrow('Preloaded delivery contained extra fields');
});

it('settles once when posting the release fails', () => {
    const { port, failed, deliver, prime, frame } = attempt('preloaded');
    prime();
    port.postMessage.mockImplementationOnce(() => {
        throw new Error('Release post failed');
    });
    frame(8);
    frame(10);
    expect(failed).toHaveBeenCalledExactlyOnceWith();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith({ kind: 'error', id: request.id, version: request.version });
    expect(port.onmessage).toBeNull();
    expect(port.terminate).toHaveBeenCalledTimes(1);
});

it('audits the direct result after the endpoint without preloading an output', async () => {
    const { port, delivery, emit, deliver, frame } = attempt('direct');
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'prepare', request, mode: 'direct' });
    emit({ kind: 'started', id: request.id, version: 1 }, 1);
    emit({ kind: 'ready', id: request.id }, 5);
    frame(8);
    frame(10);
    const reply = { kind: 'delivery', id: request.id, mode: 'direct', output: structuredClone(output) };
    emit(reply, 15, 16);
    expect(deliver.mock.lastCall?.[0].output).toBe(reply.output);
    expect(delivery.accept(reply.output, 20)).toBe(true);
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    const report = delivery.report(41);
    expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'verify', id: request.id });
    emit(
        { kind: 'verified', id: request.id, sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') },
        50,
    );
    await expect(report).resolves.toMatchObject({
        mode: 'direct',
        sameOutput: true,
        replyBytes: Buffer.byteLength(JSON.stringify(reply)),
        metrics: { releaseToFrameMs: 31 },
    });
    expect(port.terminate).toHaveBeenCalledTimes(1);
});

it.each(['mismatch', 'closed'] as const)(
    'rejects %s post-frame proof without sending a second runner response',
    async failure => {
        const { port, delivery, emit, deliver, frame } = attempt('direct');
        emit({ kind: 'started', id: request.id, version: 1 }, 1);
        emit({ kind: 'ready', id: request.id }, 5);
        frame(8);
        frame(10);
        emit({ kind: 'delivery', id: request.id, mode: 'direct', output }, 15);
        expect(delivery.accept(output, 20)).toBe(true);
        const report = delivery.report(41);
        if (failure === 'mismatch') emit({ kind: 'verified', id: request.id, sha256: '0'.repeat(64) }, 50);
        else delivery.stop();
        await expect(report).rejects.toThrow(/changed|verification interrupted/i);
        expect(deliver.mock.calls.map(([response]) => response.kind)).toEqual(['started', 'result']);
        expect(port.terminate).toHaveBeenCalledTimes(1);
    },
);

it('settles the runner when a transferable reply cannot be unpacked', () => {
    const { delivery, emit, deliver, failed, frame } = attempt('transferable');
    emit({ kind: 'started', id: request.id, version: 1 }, 1);
    emit({ kind: 'ready', id: request.id }, 5);
    frame(8);
    frame(10);
    emit({ kind: 'delivery', id: request.id, mode: 'transferable', output: { simulation: new Uint8Array(8) } }, 15);
    expect(delivery.accept(output, 20)).toBe(false);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls.map(([response]) => response.kind)).toEqual(['started', 'error']);
});

it.each(['stop', 'deadline'] as const)('rejects on %s while the local digest stalls', async action => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port, delivery, emit, deliver, frame } = attempt('direct');
    const hash = createHash('sha256').update(JSON.stringify(output)).digest();
    const pending = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(pending.promise);
    emit({ kind: 'started', id: request.id, version: 1 }, 1);
    emit({ kind: 'ready', id: request.id }, 5);
    frame(8);
    frame(10);
    emit({ kind: 'delivery', id: request.id, mode: 'direct', output }, 15);
    expect(delivery.accept(output, 20)).toBe(true);
    const report = delivery.report(41);
    const rejected = vi.fn();
    const settled = report.catch(rejected);
    emit({ kind: 'verified', id: request.id, sha256: hash.toString('hex') }, 50);
    if (action === 'stop') delivery.stop();
    await vi.advanceTimersByTimeAsync(action === 'deadline' ? 15_000 : 0);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(new Error('Renderer delivery verification interrupted'));
    await settled;
    expect(port.terminate).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls.map(([response]) => response.kind)).toEqual(['started', 'result']);
});
