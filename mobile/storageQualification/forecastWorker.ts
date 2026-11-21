import type { EngineWorkerRequest, ForecastTaskInput } from '../../src/application/engineProtocol';
import { projectForecast, type ForecastProjection } from '../../src/application/forecastProjection';
import { getActivePKParams } from '../../src/domain/engine';

/** Qualification observes the ordinary worker; it never supplies a substitute task. */
export function installForecastWorkerQualification() {
    const metrics = { requests: 0, results: 0, mcmcResults: 0, ticks: 0, maxGapMs: 0, roundTripMs: 0 };
    const last = { doseMG: 0, horizonH: 0 };
    const models = new WeakSet<Worker>();
    let sharedWorker = false;
    let fail = false;
    let active = 0;
    let initial: { input: ForecastTaskInput; output: ForecastProjection } | undefined;
    let exactBatch = false;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
            const worker = Reflect.construct(target, args) as Worker;
            const jobs = new Map<number, { input: ForecastTaskInput; started?: number; timer?: number }>();
            const stop = (id: number) => {
                const job = jobs.get(id);
                if (!job) return;
                if (job.timer) window.clearInterval(job.timer);
                jobs.delete(id);
                active--;
                return job;
            };
            worker.postMessage = new Proxy(worker.postMessage, {
                apply(post, _receiver, params) {
                    const request = params[0] as EngineWorkerRequest;
                    if (request?.kind === 'calculate' && request.input.screen) models.add(worker);
                    if (request?.kind === 'forecast') {
                        metrics.requests++;
                        if (fail) throw new Error('Synthetic Forecast worker failure');
                        sharedWorker ||= models.has(worker);
                        jobs.set(request.id, { input: structuredClone(request.input) });
                        active++;
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
                if (response.kind === 'started') {
                    job.started = performance.now();
                    let previous = job.started;
                    job.timer = window.setInterval(() => {
                        const now = performance.now();
                        metrics.ticks++;
                        metrics.maxGapMs = Math.max(metrics.maxGapMs, now - previous);
                        previous = now;
                    }, 5);
                } else if (response.kind === 'forecast-result') {
                    stop(response.id);
                    metrics.results++;
                    if (job.input.request.input.calibrationMethod === 'mcmc') metrics.mcmcResults++;
                    metrics.roundTripMs = Math.max(
                        metrics.roundTripMs,
                        performance.now() - (job.started ?? performance.now()),
                    );
                    const output = response.output as ForecastProjection;
                    initial ??= { input: job.input, output };
                    last.doseMG = job.input.request.plans.at(-1)?.spec?.doseMG ?? 0;
                    last.horizonH = job.input.request.input.horizonH;
                } else if (response.kind === 'error') stop(response.id);
            });
            return worker;
        },
    });
    Object.assign(window, {
        __hrtForecastWorkerQualification: {
            setFailure: (enabled: boolean) => {
                fail = enabled;
                return true;
            },
            compareInitial: () => {
                // Independent UI-realm replay occurs only after the timed worker window closes.
                if (!initial || active) return false;
                const clock = Date.now;
                const before = JSON.stringify(getActivePKParams());
                try {
                    Date.now = () => initial!.input.nowMs;
                    const expected = projectForecast(initial.input.request, new Map());
                    exactBatch = JSON.stringify(expected) === JSON.stringify(initial.output);
                } catch {
                    exactBatch = false;
                } finally {
                    Date.now = clock;
                }
                exactBatch &&= JSON.stringify(getActivePKParams()) === before;
                return exactBatch;
            },
            read: () => ({
                metrics: { ...metrics },
                last: { ...last },
                ordinaryForecast: metrics.results > 0,
                sharedWorker,
                exactBatch,
                active,
            }),
        },
    });
}
