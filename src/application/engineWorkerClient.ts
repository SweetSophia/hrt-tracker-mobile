import { EngineRunner, type EngineWorkerPort } from './engineRunner';

/** Bundled worker factory shared by ordinary mobile screens and qualification. */
export function createBundledEngineRunner(observe?: (worker: Worker) => void): EngineRunner {
    return new EngineRunner(() => {
        const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
        observe?.(worker);
        return worker as unknown as EngineWorkerPort;
    });
}
