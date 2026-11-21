import type { DemoOutput, DemoTaskInput } from '../../src/application/demoProtocol';
import { projectDemo } from '../../src/application/demoProjection';
import type { EngineWorkerRequest } from '../../src/application/engineProtocol';
import { getActivePKParams } from '../../src/domain/engine';

const KINDS = ['onboarding', 'model-guide', 'calibration-guide', 'sandbox'] as const;

/** Qualification observes the ordinary worker; it never supplies a substitute task. */
export function installDemoWorkerQualification() {
    const metrics = { requests: 0, results: 0, mcmcResults: 0, ticks: 0, maxGapMs: 0, roundTripMs: 0 };
    const last = { level: 0, count: 0 };
    const mcmcJobs: { ticks: number; maxGapMs: number; roundTripMs: number }[] = [];
    let suppressMcmcHeartbeat = false;
    const models = new WeakSet<Worker>();
    const initial = new Map<DemoOutput['kind'], { input: DemoTaskInput; output: DemoOutput }>();
    let sharedWorker = false;
    let initialWorker: Worker | undefined;
    let fail = false;
    let active = 0;
    let exactBatch = false;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
            const worker = Reflect.construct(target, args) as Worker;
            const jobs = new Map<
                number,
                {
                    input: DemoTaskInput;
                    ticks: number;
                    maxGapMs: number;
                    started?: number;
                    lastTick?: number;
                    ended?: number;
                    timer?: number;
                }
            >();
            const stop = (id: number) => {
                const job = jobs.get(id);
                if (!job) return;
                job.ended = performance.now();
                if (job.lastTick !== undefined) job.maxGapMs = Math.max(job.maxGapMs, job.ended - job.lastTick);
                metrics.maxGapMs = Math.max(metrics.maxGapMs, job.maxGapMs);
                if (job.timer) window.clearInterval(job.timer);
                jobs.delete(id);
                active--;
                return job;
            };
            worker.postMessage = new Proxy(worker.postMessage, {
                apply(post, _receiver, params) {
                    const request = params[0] as EngineWorkerRequest;
                    if (request?.kind === 'calculate' && request.input.screen) models.add(worker);
                    if (request?.kind === 'demo') {
                        metrics.requests++;
                        if (fail) throw new Error('Synthetic demo worker failure');
                        jobs.set(request.id, { input: structuredClone(request.input), ticks: 0, maxGapMs: 0 });
                        active++;
                    }
                    return Reflect.apply(post, worker, params);
                },
            });
            worker.terminate = new Proxy(worker.terminate, {
                apply(terminate) {
                    for (const id of [...jobs.keys()]) stop(id);
                    return Reflect.apply(terminate, worker, []);
                },
            });
            worker.addEventListener('message', event => {
                const response = event.data;
                const job = jobs.get(response?.id);
                if (!job) return;
                if (response.kind === 'started') {
                    if (job.timer) window.clearInterval(job.timer);
                    job.started = performance.now();
                    job.lastTick = job.started;
                    job.timer = window.setInterval(() => {
                        const request = job.input.request;
                        if (
                            suppressMcmcHeartbeat &&
                            request.kind === 'calibration-guide' &&
                            request.inputs.method === 'mcmc'
                        )
                            return;
                        const now = performance.now();
                        job.ticks++;
                        metrics.ticks++;
                        job.maxGapMs = Math.max(job.maxGapMs, now - job.lastTick!);
                        metrics.maxGapMs = Math.max(metrics.maxGapMs, job.maxGapMs);
                        job.lastTick = now;
                    }, 5);
                } else if (response.kind === 'demo-result') {
                    stop(response.id);
                    const output = response.output as DemoOutput;
                    if (!output || output.kind !== job.input.request.kind) return;
                    metrics.results++;
                    const request = job.input.request;
                    const roundTripMs = (job.ended ?? performance.now()) - (job.started ?? performance.now());
                    if (request.kind === 'calibration-guide' && request.inputs.method === 'mcmc') {
                        metrics.mcmcResults++;
                        mcmcJobs.push({ ticks: job.ticks, maxGapMs: job.maxGapMs, roundTripMs });
                    }
                    metrics.roundTripMs = Math.max(metrics.roundTripMs, roundTripMs);
                    if (!initial.has(output.kind)) {
                        // Check every normal kind against one model worker, then retain that cohort
                        // across intentional failure/recovery on a replacement worker.
                        if (!initialWorker) {
                            initialWorker = worker;
                            sharedWorker = true;
                        }
                        sharedWorker &&= worker === initialWorker && models.has(worker);
                        initial.set(output.kind, { input: job.input, output: structuredClone(output) });
                    }
                    if (request.kind === 'calibration-guide') {
                        last.level = request.inputs.level;
                        last.count = request.inputs.count;
                    }
                } else if (response.kind === 'error') stop(response.id);
            });
            return worker;
        },
    });
    Object.assign(window, {
        __hrtDemoWorkerQualification: {
            setFailure: (enabled: boolean) => {
                fail = enabled;
                return true;
            },
            setMcmcHeartbeatSuppressed: (enabled: boolean) => {
                suppressMcmcHeartbeat = enabled;
                return true;
            },
            compareInitial: async () => {
                // Let the caller return before replay. Each helper call then yields so a slow
                // calibration does not hold the WebView evaluate callback past its own budget.
                await new Promise<void>(resolve => window.setTimeout(resolve, 0));
                if (active || initial.size !== KINDS.length) return false;
                const clock = Date.now;
                const before = JSON.stringify(getActivePKParams());
                let exact = true;
                try {
                    for (const saved of initial.values()) {
                        if (active) return false;
                        const expected = projectDemo(saved.input);
                        exact &&= JSON.stringify(expected) === JSON.stringify(saved.output);
                        exact &&= Date.now === clock && JSON.stringify(getActivePKParams()) === before;
                        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
                    }
                } catch {
                    exact = false;
                } finally {
                    if (Date.now !== clock) Date.now = clock;
                }
                exact &&= Date.now === clock && JSON.stringify(getActivePKParams()) === before;
                exactBatch = exact;
                return exactBatch;
            },
            read: () => ({
                metrics: { ...metrics },
                mcmcJobs: mcmcJobs.map(job => ({ ...job })),
                last: { ...last },
                kinds: [...initial.keys()],
                ordinaryDemos: KINDS.every(kind => initial.has(kind)),
                sharedWorker,
                exactBatch,
                active,
            }),
        },
    });
}
