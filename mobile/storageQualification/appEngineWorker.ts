import type { ApplicationRuntime } from '../../src/application/runtime';
import type { EngineRequest, EngineOutput } from '../../src/application/engineProtocol';
import { planRecordOperation } from '../../src/records';
import { DEFAULT_PK_PARAMS } from '../../src/domain/engine';
import { mcmcInput } from './engineWorker';

/** Observe ordinary hook-created workers; never call the qualification model runner. */
export function installAppEngineWorkerQualification(runtime: ApplicationRuntime, observe: () => boolean = () => true) {
    let failRequests = false;
    const metrics = { requests: 0, results: 0, mcmcResults: 0, ticks: 0, maxGapMs: 0, roundTripMs: 0 };
    const last = { nowMs: 0, baselineHash: '', hasE2: false, samplesCovered: false };
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
            const worker = Reflect.construct(target, args) as Worker;
            const jobs = new Map<number, { input: EngineRequest['input']; started?: number; timer?: number }>();
            const stop = (id: number) => {
                const job = jobs.get(id);
                if (job?.timer) window.clearInterval(job.timer);
                jobs.delete(id);
                return job;
            };
            worker.postMessage = new Proxy(worker.postMessage, {
                apply(post, _receiver, params) {
                    const request = params[0] as EngineRequest;
                    if (request?.input?.screen && observe()) {
                        metrics.requests++;
                        if (failRequests) {
                            throw new Error('Synthetic worker failure');
                        }
                        jobs.set(request.id, { input: request.input });
                    }
                    return Reflect.apply(post, worker, params);
                },
            });
            worker.terminate = new Proxy(worker.terminate, {
                apply(terminate) {
                    for (const id of jobs.keys()) stop(id);
                    return Reflect.apply(terminate, worker, []);
                },
            });
            worker.addEventListener('message', event => {
                const response = event.data;
                const job = jobs.get(response?.id);
                if (!job) return;
                if (!observe()) {
                    stop(response.id);
                    return;
                }
                if (response.kind === 'started') {
                    job.started = performance.now();
                    let previous = job.started;
                    if (job.input.calibrationMethod === 'mcmc')
                        job.timer = window.setInterval(() => {
                            if (!observe()) return;
                            const now = performance.now();
                            metrics.ticks++;
                            metrics.maxGapMs = Math.max(metrics.maxGapMs, now - previous);
                            previous = now;
                        }, 5);
                } else if (response.kind === 'result') {
                    stop(response.id);
                    const output = response.output as EngineOutput;
                    const screen = output.screen;
                    if (!screen) return;
                    metrics.results++;
                    if (job.input.calibrationMethod === 'mcmc') metrics.mcmcResults++;
                    metrics.roundTripMs = Math.max(
                        metrics.roundTripMs,
                        performance.now() - (job.started ?? performance.now()),
                    );
                    last.nowMs = screen.nowMs;
                    last.baselineHash = '';
                    last.hasE2 = output.simulation?.concPGmL_E2.some(value => value > 0) ?? false;
                    const times = new Set(screen.sampleTimesH);
                    last.samplesCovered = [
                        ...(output.simulation?.timeH ?? []),
                        ...(screen.simulationAhead?.timeH ?? []),
                        ...job.input.events.map(event => event.timeH),
                        ...job.input.labs.map(lab => lab.timeH),
                        screen.nowMs / 3_600_000,
                    ].every(time => times.has(time));
                    const snapshot = JSON.stringify(output.simulation);
                    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot)).then(hash => {
                        if (last.nowMs === screen.nowMs)
                            last.baselineHash = Array.from(new Uint8Array(hash), byte =>
                                byte.toString(16).padStart(2, '0'),
                            ).join('');
                    });
                } else if (response.kind === 'error') stop(response.id);
            });
            return worker;
        },
    });
    Object.assign(window, {
        __hrtAppEngineWorkerQualification: {
            seed: async () => {
                const input = mcmcInput();
                metrics.requests =
                    metrics.results =
                    metrics.mcmcResults =
                    metrics.ticks =
                    metrics.maxGapMs =
                    metrics.roundTripMs =
                        0;
                last.nowMs = 0;
                last.baselineHash = '';
                await runtime.controller.dispatch(context =>
                    planRecordOperation(context, storage => {
                        storage.setItem('hrt-events', JSON.stringify(input.events));
                        storage.setItem('hrt-lab-results', JSON.stringify(input.labs));
                        storage.setItem('hrt-weight', '70');
                        storage.setItem('hrt-age-beta', 'false');
                        storage.setItem('hrt-pk-params', JSON.stringify({ ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.07 }));
                        storage.setItem('hrt-cal-method', 'mcmc');
                        storage.setItem('hrt-cal-history-mode', 'forward');
                    }),
                );
                return true;
            },
            fail: async () => {
                failRequests = true;
                await runtime.controller.refresh();
                return true;
            },
            recover: () => {
                failRequests = false;
                return true;
            },
            read: () => ({ metrics: { ...metrics }, last: { ...last } }),
        },
    });
}
