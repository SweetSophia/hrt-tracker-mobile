import { PK_SANDBOX_MODELS } from '../domain/engine';
import type { DemoTaskInput, DemoOutput } from './demoProtocol';
import { projectDemo, DemoProjectionCache } from './demoProjection';
import { TRANSFEM, TRANSMASC } from './demos/modelGuide';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clock = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export function executeDemoTask(input: DemoTaskInput, cache = new DemoProjectionCache()): DemoOutput {
    if (typeof document !== 'undefined') throw new Error('Model tasks require a worker.');
    const r = input?.request;
    let valid = !!r && clock(input?.nowMs) && (input.pkParams === null || object(input.pkParams));
    if (valid)
        switch (r.kind) {
            case 'onboarding':
                valid = typeof r.isTransmasc === 'boolean' && clock(r.anchorMs);
                break;
            case 'model-guide': {
                const ex = (r.isTransmasc ? TRANSMASC : TRANSFEM).find(e => e.id === r.routeId);
                valid =
                    typeof r.isTransmasc === 'boolean' &&
                    !!ex &&
                    ex.intervals.includes(r.everyH) &&
                    finite(r.dose) &&
                    r.dose > 0 &&
                    finite(r.weight) &&
                    r.weight >= 40 &&
                    r.weight <= 120 &&
                    finite(r.labRatio) &&
                    r.labRatio >= 0.4 &&
                    r.labRatio <= 1.8 &&
                    clock(r.singleNowMs) &&
                    clock(r.repeatedNowMs);
                break;
            }
            case 'calibration-guide': {
                const i = r.inputs;
                valid =
                    finite(r.weight) &&
                    clock(r.baseNowMs) &&
                    !!i &&
                    ['off', 'mipd', 'ekf', 'ou_kalman', 'bayes', 'mcmc'].includes(i.method) &&
                    finite(i.level) &&
                    i.level >= 0.4 &&
                    i.level <= 2.5 &&
                    finite(i.change) &&
                    i.change >= 0.5 &&
                    i.change <= 2 &&
                    Number.isInteger(i.count) &&
                    i.count >= 1 &&
                    i.count <= 6 &&
                    typeof i.wrong === 'boolean';
                break;
            }
            case 'sandbox':
                valid =
                    PK_SANDBOX_MODELS.some(m => m.id === r.modelId) &&
                    object(r.inputs) &&
                    Object.values(r.inputs).every(v => v === undefined || v === null || finite(v));
                break;
            default:
                valid = false;
        }
    if (!valid) throw new Error('Invalid demo task.');
    try {
        return projectDemo(input, cache);
    } catch {
        throw new Error('Model computation failed.');
    }
}
