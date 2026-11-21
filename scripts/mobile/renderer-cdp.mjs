const APP = 'org.askarys.hrttracker.spike.storagequalification';
const LIMIT = 32 * 1024 * 1024;
const terminal = message => Object.assign(new Error(message), { terminal: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function connect(url, signal) {
    const socket = new WebSocket(url);
    const pending = new Map(),
        events = [];
    let next = 0,
        bytes = 0,
        failure,
        intentional = false,
        complete = false;
    let resolveOpen, rejectOpen, resolveTrace, rejectTrace;
    const opened = new Promise((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
    });
    const traced = new Promise((resolve, reject) => {
        resolveTrace = resolve;
        rejectTrace = reject;
    });
    // A failed connection may never reach the trace-drain await.
    traced.catch(() => {});
    const openTimer = setTimeout(() => fail(new Error('Renderer socket open timed out')), 5000);
    const fail = error => {
        failure ??= error;
        clearTimeout(openTimer);
        rejectOpen(failure);
        rejectTrace(failure);
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(failure);
        }
        pending.clear();
    };
    const abort = () => fail(terminal('Renderer trace aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => {
        clearTimeout(openTimer);
        resolveOpen();
    });
    socket.addEventListener('error', () => fail(new Error('Renderer socket error')));
    socket.addEventListener('close', () => {
        if (!intentional) fail(new Error('Renderer socket closed'));
    });
    socket.addEventListener('message', event => {
        if (failure) return;
        try {
            if (typeof event.data !== 'string' || (bytes += Buffer.byteLength(event.data)) > LIMIT)
                throw terminal('Renderer trace exceeded data limit');
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                throw terminal('Malformed renderer protocol message');
            }
            if (!message || typeof message !== 'object' || Array.isArray(message))
                throw terminal('Malformed renderer protocol message');
            if (message.id !== undefined) {
                const item = pending.get(message.id);
                if (!item) throw terminal('Unexpected renderer response');
                pending.delete(message.id);
                clearTimeout(item.timer);
                if (message.error) item.reject(terminal('Renderer protocol error: ' + message.error.message));
                else item.resolve(message.result);
            } else if (message.method === 'Tracing.dataCollected') {
                if (!Array.isArray(message.params?.value)) throw terminal('Malformed collected trace events');
                for (const value of message.params.value) events.push(value);
            } else if (message.method === 'Tracing.tracingComplete') {
                if (complete) throw terminal('Duplicate renderer trace completion');
                complete = true;
                resolveTrace(message.params);
            }
        } catch (error) {
            fail(error);
        }
    });
    const call = async (method, params = {}) => {
        await opened;
        if (failure) throw failure;
        return new Promise((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(terminal('Renderer command timed out: ' + method));
            }, 5000);
            pending.set(id, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
                pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    };
    return {
        events,
        call,
        async evaluate(expression) {
            const response = await call('Runtime.evaluate', { expression, returnByValue: true });
            if (response?.exceptionDetails) throw terminal('Renderer evaluation failed');
            return response?.result?.value;
        },
        async finish() {
            const timeout = new Promise((_, reject) => {
                this.finishTimer = setTimeout(() => reject(terminal('Renderer trace completion timed out')), 5000);
            });
            try {
                return await Promise.race([traced, timeout]);
            } finally {
                clearTimeout(this.finishTimer);
            }
        },
        get failed() {
            return !!failure;
        },
        close() {
            intentional = true;
            signal?.removeEventListener('abort', abort);
            fail(new Error('Renderer connection released'));
            socket.close();
        },
    };
}

function endpoint(target, port) {
    const url = new URL(target.webSocketDebuggerUrl);
    if (
        typeof target.id !== 'string' ||
        !/^[A-Za-z0-9_.-]+$/.test(target.id) ||
        url.protocol !== 'ws:' ||
        url.pathname !== '/devtools/page/' + target.id ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
    )
        throw terminal('Unexpected renderer socket endpoint');
    url.hostname = '127.0.0.1';
    url.port = port;
    return url;
}
const READY =
    'location.origin === "https://localhost" && window.__hrtRendererProfileReady === true && !!window.__hrtLongHistoryQualification';

/** A fresh native-driver handshake, one app PID/page and one exclusively owned ADB forward. */
async function captureReadyRenderer({ adb, signal }) {
    const deadline = performance.now() + 75_000;
    while (performance.now() < deadline) {
        if (signal?.aborted) throw terminal('Renderer trace aborted');
        let rawPid;
        try {
            rawPid = (await adb('shell', 'pidof', APP)).trim();
        } catch (error) {
            if (signal?.aborted) throw terminal('Renderer trace aborted');
            await delay(250);
            continue;
        }
        if (!/^[1-9]\d*$/.test(rawPid) || !Number.isSafeInteger(Number(rawPid)))
            throw terminal('Invalid or ambiguous qualification app PID');
        let port,
            session,
            selected = false,
            started = false,
            ending = false,
            drained = false,
            traceCompletion,
            completed,
            failure,
            retryable;
        try {
            port = (await adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + rawPid)).trim();
            if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
                throw terminal('Invalid allocated renderer forward');
            let targets;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });
                if (!response.ok) throw new Error('Renderer discovery unavailable');
                targets = await response.json();
            } catch (error) {
                if (signal?.aborted) throw terminal('Renderer trace aborted');
                throw error;
            }
            if (!Array.isArray(targets)) throw terminal('Malformed renderer target list');
            const pages = targets.filter(target => {
                try {
                    return target.type === 'page' && new URL(target.url).origin === 'https://localhost';
                } catch {
                    return false;
                }
            });
            if (pages.length > 16) throw terminal('Too many local WebView targets');
            const readyPages = [];
            for (const candidate of pages) {
                const probe = connect(endpoint(candidate, port), signal);
                try {
                    const ready = await probe.evaluate(READY);
                    if (ready === true) readyPages.push(candidate);
                    else if (ready !== false) throw terminal('Unexpected renderer readiness acknowledgement');
                } finally {
                    probe.close();
                }
            }
            if (readyPages.length > 1) throw terminal('Ambiguous ready renderer targets');
            if (readyPages.length === 1) {
                const target = readyPages[0];
                session = connect(endpoint(target, port), signal);
                const ready = await session.evaluate(READY);
                if (ready === true) {
                    selected = true;
                    await session.call('Tracing.start', {
                        categories: 'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-v8.cpu_profiler',
                        options: 'record-as-much-as-possible',
                    });
                    started = true;
                    if ((await session.evaluate('window.__hrtRendererProfileArmed = true; true')) !== true)
                        throw terminal('Renderer trace was not armed');
                    while (true) {
                        if (signal?.aborted) throw terminal('Renderer trace aborted');
                        if (performance.now() >= deadline) throw terminal('Renderer measurement timed out');
                        const phase = await session.evaluate('window.__hrtLongHistoryQualification.read().phase');
                        if (phase === 'complete' || phase === 'failed') break;
                        if (!['idle', 'preparing', 'dispatching', 'worker', 'rendering'].includes(phase))
                            throw terminal('Unexpected renderer measurement state');
                        await delay(50);
                    }
                    ending = true;
                    await session.call('Tracing.end');
                    const result = await session.finish();
                    traceCompletion = result;
                    drained = true;
                    if (session.failed || result?.dataLossOccurred !== false)
                        throw terminal('Renderer trace data lost');
                    if (
                        (await session.evaluate(
                            'window.__hrtRendererProfileFinished = true; window.__hrtRendererProfileArmed = false; true',
                        )) !== true
                    )
                        throw terminal('Renderer trace hold was not released');
                    completed = {
                        complete: true,
                        dataLossOccurred: false,
                        traceEvents: session.events,
                        appPid: Number(rawPid),
                        targetId: target.id,
                        candidatePages: pages.length,
                    };
                } else if (ready !== false) throw terminal('Unexpected renderer readiness acknowledgement');
            }
        } catch (error) {
            if (selected || error.terminal || signal?.aborted) {
                if (session)
                    error.capture = {
                        complete: false,
                        dataLossOccurred: traceCompletion?.dataLossOccurred ?? null,
                        traceCompleteReceived: drained,
                        traceEvents: session.events,
                        appPid: Number(rawPid),
                    };
                failure = error;
            } else retryable = error;
        } finally {
            if (session) {
                if (started && !ending && !drained && !session.failed) {
                    try {
                        await session.call('Tracing.end');
                    } catch {
                        /* Preserve the original failure. */
                    }
                }
                session.close();
            }
            if (port && /^\d+$/.test(port)) {
                try {
                    await adb('forward', '--remove', 'tcp:' + port);
                } catch (error) {
                    // Removal must fail closed without discarding the capture or the primary error.
                    const cleanup = error instanceof Error ? error : new Error(String(error));
                    if (completed) {
                        failure = Object.assign(new Error('Renderer forward removal failed'), {
                            capture: completed,
                            forwardCleanupError: cleanup,
                        });
                    } else {
                        failure ??= retryable ?? new Error('Renderer forward removal failed');
                        failure.forwardCleanupError = cleanup;
                    }
                    completed = undefined;
                }
            }
        }
        if (failure) throw failure;
        if (completed) return completed;
        await delay(250);
    }
    throw terminal('Renderer attachment timed out');
}

/** The ADB adapter must kill/reap commands at a bounded deadline (host uses 5s). */
export async function captureRendererTrace({ adb, signal }) {
    const scope = new AbortController();
    const abort = () => scope.abort();
    let expired = false;
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
        expired = true;
        scope.abort();
    }, 75_000);
    try {
        return await captureReadyRenderer({ adb, signal: scope.signal });
    } catch (error) {
        if (expired) {
            const timeout = terminal('Renderer capture deadline exceeded');
            if (error.capture) timeout.capture = error.capture;
            if (error.forwardCleanupError instanceof Error) timeout.forwardCleanupError = error.forwardCleanupError;
            throw timeout;
        }
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
