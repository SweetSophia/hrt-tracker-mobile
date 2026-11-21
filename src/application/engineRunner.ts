import { validDemoOutput } from './demoOutput';
import type { DemoTaskInput, DemoOutput } from './demoProtocol';
import type {
    EngineInput,
    EngineOutput,
    EngineRequest,
    EngineWorkerRequest,
    ForecastEngineRequest,
    DemoEngineRequest,
    ForecastTaskInput,
} from './engineProtocol';
import type { ForecastProjection } from './forecastProjection';
import { validForecastOutput } from './forecastOutput';
import { screenSampleTimes } from './engineScreenSamples';

export interface EngineWorkerPort {
    postMessage(request: EngineWorkerRequest): void;
    terminate(): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { preventDefault?: () => void }) => void) | null;
    onmessageerror: ((event: unknown) => void) | null;
}
interface Job {
    id: number;
    request: EngineWorkerRequest;
    resultKind: 'result' | 'forecast-result' | 'demo-result';
    valid(value: unknown): boolean;
    resolve(value: unknown): void;
    reject(error: Error): void;
    settled: boolean;
    signal?: AbortSignal;
    abort?: () => void;
    timer?: ReturnType<typeof setTimeout>;
}
const cancelled = () => Object.assign(new Error('Model computation cancelled.'), { name: 'AbortError' });
const failed = () => new Error('Model computation failed.');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const finiteArray = (value: unknown, length: number): value is number[] =>
    Array.isArray(value) && value.length === length && value.every(n => typeof n === 'number' && Number.isFinite(n));
const validSimulation = (value: unknown): boolean => {
    if (value === null) return true;
    if (!object(value) || !Array.isArray(value.timeH)) return false;
    const size = value.timeH.length;
    return ['timeH', 'concPGmL_E2', 'concPGmL_CPA', 'concNGdL_T'].every(key => finiteArray(value[key], size));
};
function validOutput(value: unknown, input: EngineInput): value is EngineOutput {
    if (!object(value) || !object(value.calibration)) return false;
    const n = input.sampleTimesH.length;
    const c = value.calibration;
    if (
        !finiteArray(value.sampleTimesH, n) ||
        value.sampleTimesH.some((time, i) => time !== input.sampleTimesH[i]) ||
        !finiteArray(value.factors, n) ||
        (value.factorSDs !== null && !finiteArray(value.factorSDs, n)) ||
        c.method !== input.calibrationMethod ||
        !Array.isArray(c.points) ||
        !['scale', 'kMul', 'halfLifeDeltaPct', 'n'].every(
            key => typeof c[key] === 'number' && Number.isFinite(c[key]),
        ) ||
        (c.fitErrPct !== null && (typeof c.fitErrPct !== 'number' || !Number.isFinite(c.fitErrPct)))
    )
        return false;
    if (!validSimulation(value.simulation)) return false;
    if (!input.screen) return value.screen === undefined;
    const screen = value.screen;
    if (!object(screen) || screen.nowMs !== input.screen.nowMs || !validSimulation(screen.simulationAhead))
        return false;
    // Only consume the typed shapes after checking their complete numeric arrays.
    const expected = screenSampleTimes(
        input,
        value.simulation as EngineOutput['simulation'],
        screen.simulationAhead as EngineOutput['simulation'],
    );
    if (
        !finiteArray(screen.sampleTimesH, expected.length) ||
        screen.sampleTimesH.some((time, i) => time !== expected[i]) ||
        !finiteArray(screen.factors, expected.length) ||
        (screen.factorSDs !== null && !finiteArray(screen.factorSDs, expected.length))
    )
        return false;
    const times = new Set(expected);
    return c.points.every(
        point =>
            object(point) &&
            typeof point.timeH === 'number' &&
            times.has(point.timeH) &&
            ['pred', 'obs', 'ratio'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key])),
    );
}

type TaskRequest =
    | Omit<EngineRequest, 'version' | 'id'>
    | Omit<ForecastEngineRequest, 'version' | 'id'>
    | Omit<DemoEngineRequest, 'version' | 'id'>;

/** One physical worker; one active job and the latest pending job per task kind. */
export class EngineRunner {
    private context: string | undefined;
    private worker: EngineWorkerPort | undefined;
    private active: Job | undefined;
    private pending = new Map<EngineWorkerRequest['kind'], Job>();
    private nextId = 1;
    private disposed = false;
    constructor(
        private readonly factory: () => EngineWorkerPort,
        private readonly timeoutMs = 30_000,
    ) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid model timeout.');
    }
    activate(contextKey: string): void {
        if (this.disposed) throw new Error('Model runner is disposed.');
        if (!contextKey) throw new Error('No active model context.');
        if (this.context === contextKey) return;
        this.clear();
        this.context = contextKey;
    }
    calculate(input: EngineInput, options: { signal?: AbortSignal } = {}): Promise<EngineOutput> {
        return this.schedule<EngineOutput>({ kind: 'calculate', input }, options);
    }
    forecast(input: ForecastTaskInput, options: { signal?: AbortSignal } = {}): Promise<ForecastProjection> {
        return this.schedule<ForecastProjection>({ kind: 'forecast', input }, options);
    }
    demo(input: DemoTaskInput, options: { signal?: AbortSignal } = {}): Promise<DemoOutput> {
        return this.schedule<DemoOutput>({ kind: 'demo', input }, options);
    }
    private schedule<T>(request: TaskRequest, options: { signal?: AbortSignal }): Promise<T> {
        if (this.disposed) return Promise.reject(new Error('Model runner is disposed.'));
        if (!this.context) return Promise.reject(new Error('No active model context.'));
        if (options.signal?.aborted) return Promise.reject(cancelled());
        let captured: TaskRequest;
        try {
            captured = structuredClone(request);
            if (
                !Number.isSafeInteger(this.nextId) ||
                (captured.kind === 'calculate'
                    ? !Array.isArray(captured.input.sampleTimesH)
                    : captured.kind === 'forecast'
                      ? !Array.isArray(captured.input.request?.plans)
                      : typeof captured.input.request?.kind !== 'string')
            )
                throw failed();
        } catch {
            return Promise.reject(failed());
        }
        return new Promise<T>((resolve, reject) => {
            const id = this.nextId++;
            const job: Job = {
                id,
                request: { version: 1, id, ...captured },
                resultKind:
                    captured.kind === 'calculate'
                        ? 'result'
                        : captured.kind === 'forecast'
                          ? 'forecast-result'
                          : 'demo-result',
                valid:
                    captured.kind === 'calculate'
                        ? value => validOutput(value, captured.input as EngineInput)
                        : captured.kind === 'forecast'
                          ? value => validForecastOutput(value, (captured.input as ForecastTaskInput).request)
                          : value => validDemoOutput(value, (captured.input as DemoTaskInput).request),
                // Every success passes the matching task validator before settle.
                resolve: value => resolve(value as T),
                reject,
                settled: false,
                signal: options.signal,
            };
            job.abort = () => {
                if (this.pending.get(job.request.kind) === job) {
                    this.pending.delete(job.request.kind);
                    this.settle(job, cancelled());
                } else if (this.active === job) this.complete(job, cancelled());
            };
            const previous = this.pending.get(job.request.kind);
            if (previous) this.settle(previous, cancelled());
            // Same-kind supersession rejects now; the worker finishes its current turn.
            if (this.active?.request.kind === job.request.kind) this.settle(this.active, cancelled());
            this.pending.set(job.request.kind, job);
            job.signal?.addEventListener('abort', job.abort, { once: true });
            this.dispatch();
        });
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.clear();
        this.context = undefined;
    }
    private settle(job: Job, error?: Error, value?: unknown): void {
        if (job.settled) return;
        job.settled = true;
        if (job.abort) job.signal?.removeEventListener('abort', job.abort);
        if (error) job.reject(error);
        else job.resolve(value!);
    }
    private resetWorker(): void {
        const old = this.worker;
        this.worker = undefined;
        if (old) {
            old.onmessage = null;
            old.onerror = null;
            old.onmessageerror = null;
            old.terminate();
        }
    }
    private clear(): void {
        for (const job of this.pending.values()) this.settle(job, cancelled());
        this.pending.clear();
        if (this.active) {
            clearTimeout(this.active.timer);
            this.settle(this.active, cancelled());
        }
        this.active = undefined;
        this.resetWorker();
    }
    private complete(job: Job, error?: Error, value?: unknown): void {
        if (this.active !== job) return;
        clearTimeout(job.timer);
        this.active = undefined;
        if (error) this.resetWorker();
        this.settle(job, error, value);
        this.dispatch();
    }
    private dispatch(): void {
        if (this.active || !this.pending.size || this.disposed) return;
        const job = this.pending.values().next().value!;
        this.pending.delete(job.request.kind);
        this.active = job;
        try {
            if (!this.worker) {
                const worker = this.factory();
                this.worker = worker;
                worker.onmessage = event => {
                    if (this.worker !== worker) return;
                    const response = event.data;
                    const active = this.active;
                    if (!active || !object(response) || response.id !== active.id) return;
                    if (response.version !== 1) {
                        this.complete(active, failed());
                        return;
                    }
                    if (response.kind === 'started') return;
                    if (response.kind !== active.resultKind || !active.valid(response.output))
                        this.complete(active, failed());
                    else this.complete(active, undefined, response.output);
                };
                worker.onerror = event => {
                    event.preventDefault?.();
                    if (this.worker !== worker) return;
                    if (this.active) this.complete(this.active, failed());
                    else this.resetWorker();
                };
                worker.onmessageerror = () => {
                    if (this.worker !== worker) return;
                    if (this.active) this.complete(this.active, failed());
                    else this.resetWorker();
                };
            }
            job.timer = setTimeout(() => this.complete(job, new Error('Model computation timed out.')), this.timeoutMs);
            this.worker.postMessage(job.request);
        } catch {
            this.complete(job, failed());
        }
    }
}
