import { afterEach, expect, it, vi } from 'vitest';
import { captureRendererTrace } from '../../scripts/mobile/renderer-cdp.mjs';

const setup = (
    change: {
        phase?: string;
        readyAfter?: number;
        closeAt?: string;
        protocolError?: string;
        exception?: boolean;
        noComplete?: boolean;
        malformed?: boolean;
        overflow?: boolean;
        dataLoss?: boolean;
        pid?: string;
        foreign?: boolean;
        hangFetch?: boolean;
        pages?: 'stale-and-ready' | 'two-ready';
        removeRejects?: boolean | 'delayed';
    } = {},
) => {
    vi.useFakeTimers();
    const forwarded = new Set(['5444']);
    const events = [{ name: 'captured-task', ph: 'X', ts: 100, dur: 20, pid: 44, tid: 55 }];
    let reads = 0;
    let sentMalformed = false;
    const effects: string[] = [];
    const calls: string[] = [];
    const adb = async (...args: string[]) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'shell pidof org.askarys.hrttracker.spike.storagequalification') return change.pid ?? '4321';
        if (command === 'forward tcp:0 localabstract:webview_devtools_remote_4321') {
            forwarded.add('4567');
            return '4567';
        }
        if (command === 'forward --remove tcp:4567') {
            if (change.removeRejects === 'delayed') {
                await new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Synthetic forward removal failure')), 80_000),
                );
            }
            if (change.removeRejects) throw new Error('Synthetic forward removal failure');
            forwarded.delete('4567');
            return '';
        }
        throw new Error('Unexpected device command: ' + command);
    };
    vi.stubGlobal('fetch', async (url: string, options?: { signal?: AbortSignal }) => {
        if (change.hangFetch)
            await new Promise((_, reject) =>
                options?.signal?.addEventListener('abort', () => reject(new Error('Discovery aborted')), {
                    once: true,
                }),
            );
        if (url !== 'http://127.0.0.1:4567/json/list') throw new Error('Unexpected endpoint');
        return {
            ok: true,
            json: async () => {
                const page = {
                    id: 'page-1',
                    type: 'page',
                    url: change.foreign ? 'https://localhost.example/' : 'https://localhost/',
                    webSocketDebuggerUrl: 'ws://localhost:4567/devtools/page/page-1',
                };
                return change.pages
                    ? [
                          { ...page, id: 'page-2', webSocketDebuggerUrl: 'ws://localhost:4567/devtools/page/page-2' },
                          page,
                      ]
                    : [page];
            },
        };
    });
    class Socket extends EventTarget {
        pageId: string;
        constructor(url: string | URL) {
            super();
            const valid = ['ws://127.0.0.1:4567/devtools/page/page-1'];
            if (change.pages) valid.push('ws://127.0.0.1:4567/devtools/page/page-2');
            if (!valid.includes(String(url))) throw new Error('Wrong socket');
            this.pageId = String(url).split('/').at(-1)!;
            queueMicrotask(() => this.dispatchEvent(new Event('open')));
        }
        close() {
            this.dispatchEvent(new Event('close'));
        }
        message(value: unknown) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
        }
        send(raw: string) {
            const { id, method, params } = JSON.parse(raw);
            queueMicrotask(() => {
                if (change.closeAt === method) {
                    this.close();
                    return;
                }
                if (change.protocolError === method) {
                    this.message({ id, error: { message: 'Synthetic protocol error' } });
                    return;
                }
                let result: unknown = {};
                if (method === 'Runtime.evaluate') {
                    const expression = params.expression;
                    let value: unknown = true;
                    if (expression.includes('__hrtRendererProfileReady'))
                        value =
                            this.pageId === 'page-2'
                                ? change.pages === 'two-ready'
                                : ++reads >= (change.readyAfter ?? 1);
                    else if (expression.includes('.read().phase')) value = change.phase ?? 'complete';
                    else if (expression.includes('__hrtRendererProfileFinished')) effects.push('finished');
                    else if (expression.includes('__hrtRendererProfileArmed')) effects.push('armed');
                    if (change.exception && expression.includes('__hrtRendererProfileArmed'))
                        result = { exceptionDetails: { text: 'Synthetic evaluation error' } };
                    else result = { result: { value } };
                } else if (!['Tracing.start', 'Tracing.end'].includes(method)) throw new Error('Unexpected CDP method');
                if (change.malformed && method === 'Runtime.evaluate' && !sentMalformed) {
                    sentMalformed = true;
                    this.message(null);
                    return;
                }
                this.message({ id, result });
                if (method === 'Tracing.end') {
                    effects.push('trace-stopped');
                    if (change.overflow)
                        this.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(32 * 1024 * 1024 + 1) }));
                    else this.message({ method: 'Tracing.dataCollected', params: { value: events } });
                    if (!change.noComplete)
                        this.message({
                            method: 'Tracing.tracingComplete',
                            params: { dataLossOccurred: change.dataLoss ?? false },
                        });
                }
            });
        }
    }
    vi.stubGlobal('WebSocket', Socket);
    return { adb, forwarded, effects, events, calls };
};
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
it('drains collected events and completion before releasing the native hold and only its own forward', async () => {
    const { adb, forwarded, effects, events } = setup();
    const result = await captureRendererTrace({ adb });
    expect(result).toMatchObject({
        complete: true,
        dataLossOccurred: false,
        traceEvents: events,
        appPid: 4321,
        targetId: 'page-1',
    });
    expect(effects).toEqual(['armed', 'trace-stopped', 'finished']);
    expect([...forwarded]).toEqual(['5444']);
});
it('waits for the fresh ready page before arming a measurement', async () => {
    const { adb, effects, forwarded } = setup({ readyAfter: 3 });
    const capture = captureRendererTrace({ adb });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(capture).resolves.toMatchObject({ complete: true });
    expect(effects).toEqual(['armed', 'trace-stopped', 'finished']);
    expect([...forwarded]).toEqual(['5444']);
});
it.each(['Tracing.start', 'Tracing.end'])('fails on %s protocol error and releases its forward', async method => {
    const { adb, forwarded } = setup({ protocolError: method });
    await expect(captureRendererTrace({ adb })).rejects.toThrow();
    expect([...forwarded]).toEqual(['5444']);
});
it('does not reconnect into success after the selected ready target disconnects', async () => {
    const { adb, forwarded } = setup({ closeAt: 'Tracing.start' });
    await expect(captureRendererTrace({ adb })).rejects.toThrow();
    expect([...forwarded]).toEqual(['5444']);
});
it('rejects Runtime evaluation exceptions rather than accepting an acknowledgement', async () => {
    const { adb, forwarded, effects } = setup({ exception: true });
    await expect(captureRendererTrace({ adb })).rejects.toThrow();
    expect(effects).not.toContain('finished');
    expect([...forwarded]).toEqual(['5444']);
});
it('requires tracingComplete after an end acknowledgement', async () => {
    const { adb, forwarded, effects } = setup({ noComplete: true });
    const failed = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failed).toBeInstanceOf(Error);
    expect(effects).not.toContain('finished');
    expect(effects.filter(effect => effect === 'trace-stopped')).toHaveLength(1);
    expect([...forwarded]).toEqual(['5444']);
});
it('bounds received trace data before parsing or accepting it', async () => {
    const { adb, forwarded } = setup({ overflow: true });
    await expect(captureRendererTrace({ adb })).rejects.toThrow(/limit|large/i);
    expect([...forwarded]).toEqual(['5444']);
});
it.each(['', '1 2', '../socket'])('rejects an ambiguous or invalid app PID %s', async pid => {
    const { adb, forwarded } = setup({ pid });
    await expect(captureRendererTrace({ adb })).rejects.toThrow();
    expect([...forwarded]).toEqual(['5444']);
});
it('does not arm an app page with a lookalike external origin', async () => {
    const { adb, forwarded, effects } = setup({ foreign: true });
    const failed = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await failed).toBeInstanceOf(Error);
    expect(effects).toEqual([]);
    expect([...forwarded]).toEqual(['5444']);
});
it('aborts a held measurement without leaking the selected connection', async () => {
    const { adb, forwarded } = setup({ phase: 'worker' });
    const abort = new AbortController();
    const failed = captureRendererTrace({ adb, signal: abort.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(Error);
    expect([...forwarded]).toEqual(['5444']);
});

it('does not stop another trace when Tracing.start was rejected', async () => {
    const { adb, effects } = setup({ protocolError: 'Tracing.start' });
    await expect(captureRendererTrace({ adb })).rejects.toThrow();
    expect(effects).not.toContain('trace-stopped');
});
it('rejects reported data loss before acknowledging the native hold', async () => {
    const { adb, forwarded, effects } = setup({ dataLoss: true });
    await expect(captureRendererTrace({ adb })).rejects.toThrow(/lost/i);
    expect(effects).not.toContain('finished');
    expect([...forwarded]).toEqual(['5444']);
});

it('selects the sole freshly ready WebView when recreation retains an older local page', async () => {
    const { adb, effects, forwarded } = setup({ pages: 'stale-and-ready' });
    const capture = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await capture).toMatchObject({ complete: true, targetId: 'page-1' });
    expect(effects).toEqual(['armed', 'trace-stopped', 'finished']);
    expect([...forwarded]).toEqual(['5444']);
});
it('refuses two ready WebViews rather than choosing a page arbitrarily', async () => {
    const { adb, effects, forwarded } = setup({ pages: 'two-ready' });
    const capture = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await capture).toBeInstanceOf(Error);
    expect(effects).toEqual([]);
    expect([...forwarded]).toEqual(['5444']);
});

it('rejects a malformed envelope immediately after selecting the ready page', async () => {
    const { adb, forwarded } = setup({ malformed: true });
    const failed = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failed).toMatchObject({ message: 'Malformed renderer protocol message' });
    expect([...forwarded]).toEqual(['5444']);
});

it('keeps producer data loss unknown when the connection fails before trace completion', async () => {
    const { adb } = setup({ closeAt: 'Tracing.start' });
    const error = await captureRendererTrace({ adb }).catch(error => error);
    expect(error.capture).toMatchObject({ complete: false, dataLossOccurred: null, traceCompleteReceived: false });
});

it('cancels a stalled discovery request at the capture deadline and removes its forward', async () => {
    const { adb, forwarded } = setup({ hangFetch: true });
    const abort = new AbortController();
    let settled = false;
    const result = captureRendererTrace({ adb, signal: abort.signal }).then(
        value => {
            settled = true;
            return value;
        },
        error => {
            settled = true;
            return error;
        },
    );
    try {
        await vi.advanceTimersByTimeAsync(80_000);
        expect(settled).toBe(true);
        expect(await result).toMatchObject({ message: 'Renderer capture deadline exceeded' });
        expect([...forwarded]).toEqual(['5444']);
    } finally {
        abort.abort();
        await vi.advanceTimersByTimeAsync(100);
        await result;
    }
});

it('fails closed with the completed trace when forward removal fails', async () => {
    const { adb, calls, events } = setup({ removeRejects: true });
    const error = await captureRendererTrace({ adb }).catch(error => error);
    expect(error).toMatchObject({
        message: 'Renderer forward removal failed',
        capture: {
            complete: true,
            dataLossOccurred: false,
            traceEvents: events,
            appPid: 4321,
            targetId: 'page-1',
        },
    });
    expect(error.forwardCleanupError).toBeInstanceOf(Error);
    expect(error.forwardCleanupError).not.toBe(error);
    expect(error.forwardCleanupError.message).toBe('Synthetic forward removal failure');
    expect(calls.filter(call => call.startsWith('forward'))).toEqual([
        'forward tcp:0 localabstract:webview_devtools_remote_4321',
        'forward --remove tcp:4567',
    ]);
});

it('preserves the renderer failure and partial trace when forward removal fails', async () => {
    const { adb, calls, events } = setup({ dataLoss: true, removeRejects: true });
    const error = await captureRendererTrace({ adb }).catch(error => error);
    expect(error).toMatchObject({
        message: 'Renderer trace data lost',
        terminal: true,
        capture: {
            complete: false,
            dataLossOccurred: true,
            traceCompleteReceived: true,
            traceEvents: events,
            appPid: 4321,
        },
    });
    expect(error.forwardCleanupError).toBeInstanceOf(Error);
    expect(error.forwardCleanupError).not.toBe(error);
    expect(error.forwardCleanupError.message).toBe('Synthetic forward removal failure');
    expect(calls.filter(call => call.startsWith('forward --remove'))).toEqual(['forward --remove tcp:4567']);
});

it('keeps the completed trace and cleanup error when the deadline wrapper times out during removal', async () => {
    const { adb, calls, events } = setup({ removeRejects: 'delayed' });
    const pending = captureRendererTrace({ adb }).catch(error => error);
    await vi.advanceTimersByTimeAsync(80_000);
    const error = await pending;
    expect(error).toMatchObject({
        message: 'Renderer capture deadline exceeded',
        terminal: true,
        capture: {
            complete: true,
            dataLossOccurred: false,
            traceEvents: events,
            appPid: 4321,
            targetId: 'page-1',
        },
    });
    expect(error.forwardCleanupError).toBeInstanceOf(Error);
    expect(error.forwardCleanupError.message).toBe('Synthetic forward removal failure');
    expect(calls.filter(call => call.startsWith('forward --remove'))).toEqual(['forward --remove tcp:4567']);
});
