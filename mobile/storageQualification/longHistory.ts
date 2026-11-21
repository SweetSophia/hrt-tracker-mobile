/// <reference types="vite/client" />

import deliveryWorkerUrl from './rendererDelivery.worker?worker&url';
import { isUnstagedDelivery, startRendererDelivery, type DeliveryMode } from './rendererDelivery';
import { markRendererPhase } from './rendererMarks';
import { EngineRunner } from '../../src/application/engineRunner';
import type { ApplicationRuntime } from '../../src/application/runtime';
import type { EngineWorkerRequest, EngineOutput, EngineRequest } from '../../src/application/engineProtocol';
import type { RecordScope } from '../../src/records/scope';
import type { StoreSnapshots } from '../../src/platform/contracts';
import { createNativeStores } from '../../src/platform/capacitor';
import { planRecordOperation } from '../../src/records';
import { cappedMcmcInput } from './longHistoryFixture';
import { ScreenPerformanceTrace } from './performanceTrace';

/** A laid-out ordinary ResultChart, excluding hidden/inert old model boundaries. */
function overviewReady(): boolean {
    const visible = (n: Element) =>
        n.getClientRects().length > 0 &&
        !n.closest('[aria-hidden="true"],[inert]') &&
        getComputedStyle(n).visibility !== 'hidden';
    if (
        [...document.querySelectorAll('[role=status],[role=alert]')].some(
            n => visible(n) && /Updating estimates|Estimates could not be calculated/.test(n.textContent ?? ''),
        )
    )
        return false;
    return [...document.querySelectorAll('.main-view svg g[clip-path] path[stroke-width="2"][fill="none"]')].some(
        n => visible(n) && (n.getAttribute('d')?.length ?? 0) > 10,
    );
}
const canonical = (snapshots: StoreSnapshots) =>
    JSON.stringify(
        Object.keys(snapshots)
            .sort()
            .map(ns => [
                ns,
                snapshots[ns].revision,
                Object.entries(snapshots[ns].entries).sort(([a], [b]) => a.localeCompare(b)),
            ]),
    );
const digest = async (text: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte =>
        byte.toString(16).padStart(2, '0'),
    ).join('');

const isMeasuredRequest = (request: EngineWorkerRequest): request is EngineRequest =>
    request?.kind === 'calculate' &&
    !!request.input.screen &&
    request.input.calibrationMethod === 'mcmc' &&
    request.input.events.some(event => event.id === 'synthetic-long-history-anchor');

/** Observe ordinary record admission and the hook-created worker, never a substitute runner. */
export function installLongHistoryQualification(runtime: ApplicationRuntime) {
    const trace = new ScreenPerformanceTrace();
    let acknowledgement: StoreSnapshots | undefined;
    let acknowledgedScope: RecordScope | undefined;
    let failureReason: string | undefined;
    let timer: number | undefined, frame: number | undefined, deadline: number | undefined;
    let nextWorker = 0;
    let selectedRequest: EngineWorkerRequest | undefined;
    let deliveryMode: DeliveryMode | undefined;
    let delivery: ReturnType<typeof startRendererDelivery> | undefined;
    let comparisonFrameAt: number | undefined;
    const clearDelivery = () => {
        delivery?.close();
        delivery = undefined;
        comparisonFrameAt = undefined;
    };
    const stopTimers = ({ rejectDelivery = false, retainDelivery = false } = {}) => {
        if (timer !== undefined) window.clearInterval(timer);
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        if (deadline !== undefined) window.clearTimeout(deadline);
        timer = frame = deadline = undefined;
        if (rejectDelivery) delivery?.stop();
        else if (!retainDelivery) delivery?.close();
    };
    // Qualification-only coupling to the runner's synchronous completion boundary.
    // Its real reason is available before resetWorker() terminates the port; neither
    // termination nor elapsed time proves cancellation. Rearm requires the exact
    // posted request identity. Before a post, only this fixture's failure counts.
    const complete = Reflect.get(EngineRunner.prototype, 'complete');
    if (typeof complete !== 'function') throw new Error('Missing runner completion boundary.');
    Reflect.set(
        EngineRunner.prototype,
        'complete',
        new Proxy(complete, {
            apply(settle, runner, args) {
                const [job, error, output] = args as [{ request: EngineWorkerRequest }, Error | undefined, unknown];
                if (
                    trace.active &&
                    error &&
                    (job.request === selectedRequest ||
                        (!selectedRequest &&
                            trace.read().phase === 'preparing' &&
                            error.name !== 'AbortError' &&
                            isMeasuredRequest(job.request)))
                ) {
                    const state = trace.read();
                    if (error.name === 'AbortError') {
                        const now = performance.now();
                        if (trace.cancel(now, state.workerId, state.requestId))
                            markRendererPhase('cancel', state.workerId, state.requestId, now);
                        selectedRequest = undefined;
                        clearDelivery();
                    } else {
                        failureReason = selectedRequest ? 'runner-failure' : 'runner-failure-before-post';
                        trace.fail();
                        stopTimers();
                    }
                } else if (trace.active && delivery && job.request === selectedRequest && !error) {
                    if (!delivery.accept(output, performance.now())) {
                        failureReason = 'delivery-acceptance';
                        trace.fail();
                        stopTimers();
                    }
                }
                return Reflect.apply(settle, runner, args);
            },
        }),
    );
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
            const worker = Reflect.construct(target, args) as Worker,
                workerId = ++nextWorker;
            worker.postMessage = new Proxy(worker.postMessage, {
                apply(post, _receiver, params) {
                    const request = params[0] as EngineWorkerRequest;
                    if (trace.active && isMeasuredRequest(request)) {
                        const now = performance.now();
                        if (
                            trace.post(
                                now,
                                workerId,
                                request.id,
                                request.input.events.length,
                                request.input.calibrationMethod,
                            )
                        ) {
                            selectedRequest = request;
                            markRendererPhase('post', workerId, request.id, now);
                            if (deliveryMode) {
                                // Select only this synthetic request. The runner and validator receive
                                // the standard started/result messages in each delivery mode.
                                delivery = startRendererDelivery(
                                    new NativeWorker(deliveryWorkerUrl, { type: 'module' }),
                                    request,
                                    deliveryMode,
                                    {
                                        deliver: data => worker.dispatchEvent(new MessageEvent('message', { data })),
                                        mark: (phase, time) => markRendererPhase(phase, workerId, request.id, time),
                                        failed: () => {
                                            failureReason = 'comparison-worker-failure';
                                            trace.fail();
                                            stopTimers();
                                        },
                                    },
                                );
                                return;
                            }
                        }
                    }
                    try {
                        return Reflect.apply(post, worker, params);
                    } catch (error) {
                        if (trace.active) {
                            trace.fail();
                            stopTimers();
                        }
                        throw error;
                    }
                },
            });
            worker.terminate = new Proxy(worker.terminate, {
                apply(terminate) {
                    if (trace.active && trace.read().workerId === workerId) {
                        failureReason = 'unconfirmed-worker-termination';
                        trace.fail();
                        stopTimers({ rejectDelivery: true });
                    }
                    return Reflect.apply(terminate, worker, []);
                },
            });
            for (const type of ['error', 'messageerror'])
                worker.addEventListener(type, () => {
                    if (trace.active && trace.read().workerId === workerId) {
                        failureReason = 'worker-error';
                        trace.fail();
                        stopTimers();
                    }
                });
            worker.addEventListener('message', event => {
                if (!trace.active) return;
                const r = event.data;
                if (r?.kind === 'started') {
                    const now = performance.now();
                    if (trace.started(now, workerId, r.id)) markRendererPhase('started', workerId, r.id, now);
                } else if (r?.kind === 'result') {
                    const output = r.output as EngineOutput;
                    const now = performance.now();
                    if (
                        trace.received(
                            now,
                            workerId,
                            r.id,
                            output?.simulation?.timeH.length ?? 0,
                            output?.screen?.sampleTimesH.length ?? 0,
                        )
                    )
                        markRendererPhase('result', workerId, r.id, now);
                } else if (
                    r?.kind === 'error' &&
                    trace.read().workerId === workerId &&
                    trace.read().requestId === r.id
                ) {
                    trace.fail();
                    stopTimers();
                }
            });
            return worker;
        },
    });
    Object.assign(window, {
        __hrtLongHistoryQualification: {
            start: async (mode?: DeliveryMode) => {
                if (trace.active) throw new Error('Measurement already active.');
                if (
                    mode !== undefined &&
                    ((mode !== 'worker' && mode !== 'preloaded' && !isUnstagedDelivery(mode)) ||
                        Reflect.get(window, '__hrtRendererProfileArmed') !== true)
                )
                    throw new Error('Delivery comparison requires an armed renderer profile.');
                clearDelivery();
                deliveryMode = mode;
                const current = runtime.controller.getState();
                if (current.status !== 'ready' || current.scope.mode !== 'transfem')
                    throw new Error('Unexpected measurement scope.');
                // Fixture generation (including synthetic reference labs) is not renderer timing.
                const input = cappedMcmcInput(Date.now());
                const events = JSON.stringify(input.events),
                    labs = JSON.stringify(input.labs);
                acknowledgement = undefined;
                selectedRequest = undefined;
                failureReason = undefined;
                const actionAt = performance.now();
                trace.begin(actionAt);
                markRendererPhase('action', 0, 0, actionAt);
                timer = window.setInterval(() => trace.tick(performance.now()), 5);
                const observeFrame = () => {
                    if (!trace.active) {
                        stopTimers({ rejectDelivery: true });
                        return;
                    }
                    const state = trace.read();
                    const ready = state.phase === 'rendering' && overviewReady();
                    const now = performance.now();
                    if (state.phase === 'rendering' && trace.presented(now, state.workerId, state.requestId, ready)) {
                        markRendererPhase('frame', state.workerId, state.requestId, now);
                        if (delivery) comparisonFrameAt = now;
                        stopTimers({ retainDelivery: isUnstagedDelivery(deliveryMode) });
                        return;
                    }
                    frame = window.requestAnimationFrame(observeFrame);
                };
                frame = window.requestAnimationFrame(observeFrame);
                deadline = window.setTimeout(() => {
                    failureReason = 'deadline';
                    trace.fail();
                    stopTimers({ rejectDelivery: true });
                }, 45_000);
                try {
                    const receipt = await runtime.controller.dispatch(context =>
                        planRecordOperation(context, storage => {
                            storage.setItem('hrt-events', events);
                            storage.setItem('hrt-lab-results', labs);
                            storage.setItem('hrt-weight', '70');
                            storage.setItem('hrt-age-beta', 'false');
                            storage.setItem('hrt-pk-params', 'null');
                            storage.setItem('hrt-cal-method', 'mcmc');
                            storage.setItem('hrt-cal-history-mode', 'forward');
                        }),
                    );
                    const state = runtime.controller.getState();
                    if (!receipt.active || state.status !== 'ready' || state.scope !== current.scope)
                        throw new Error('Measurement scope changed.');
                    // Controller snapshots are deep-frozen. Serialize/hash only after the window.
                    acknowledgement = state.snapshots;
                    acknowledgedScope = state.scope;
                    return true;
                } catch (error) {
                    trace.fail();
                    stopTimers({ rejectDelivery: true });
                    throw error;
                }
            },
            read: () => ({ ...trace.read(), failureReason }),
            screenReady: overviewReady,
            stop: () => {
                trace.fail();
                stopTimers({ rejectDelivery: true });
                clearDelivery();
                return true;
            },
            finalize: async () => {
                if (trace.read().phase !== 'complete' || !acknowledgement)
                    throw new Error('Measurement is not complete.');
                const frameAt = comparisonFrameAt;
                if (delivery !== undefined && frameAt === undefined) throw new Error('Incomplete renderer delivery');
                const comparison = frameAt === undefined ? undefined : await delivery?.report(frameAt);
                if (deliveryMode && !comparison) throw new Error('Missing renderer delivery comparison.');
                const records = createNativeStores().records;
                await records.initialize();
                const actual = Object.fromEntries(
                    await Promise.all(
                        Object.keys(acknowledgement).map(async ns => [ns, await records.read(ns)] as const),
                    ),
                );
                const before = canonical(acknowledgement),
                    after = canonical(actual),
                    current = runtime.controller.getState();
                return {
                    trace: trace.read(),
                    ...(comparison ? { deliveryComparison: comparison } : {}),
                    beforeHash: await digest(before),
                    afterHash: await digest(after),
                    snapshotUnchanged:
                        before === after &&
                        current.status === 'ready' &&
                        current.scope === acknowledgedScope &&
                        canonical(current.snapshots) === before,
                };
            },
        },
    });
    return { isActive: () => trace.active };
}
