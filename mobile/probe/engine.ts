import fixture from '../../tests/fixtures/mobile/feasibility.json';
import { longHistory, modelReference, mcmcReference } from './reference';

// Time-grid precision follows simulation.test.ts (6 places); E2/CPA follow
// its 9-place superposition checks. T uses 6 places; calibration 8 places.
// These compare the same algorithm across engines, not clinical accuracy.
export function checkReference(actual: unknown): boolean {
    function equal(a: unknown, b: unknown, path = ''): boolean {
        if (typeof b === 'number') {
            const tolerance =
                path.includes('timeH') || path.includes('testosteroneNgDl')
                    ? 1e-6
                    : path.includes('calibration')
                      ? 1e-8
                      : 1e-9;
            return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= tolerance;
        }
        if (b === null || typeof b !== 'object') return a === b;
        if (a === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
        const keys = Object.keys(b);
        return (
            Object.keys(a).length === keys.length &&
            keys.every(key =>
                equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`),
            )
        );
    }
    return equal(actual, fixture.reference);
}

export async function engineProbe() {
    const checks: Record<string, boolean> = { reference: checkReference(modelReference()) };
    const metricsMs: Record<string, number> = {};
    for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const nextTurn = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0));
        const long = longHistory();
        metricsMs[`longHistory${i}`] = performance.now() - start;
        checks[`gridCap${i}`] =
            long.timeH.length === fixture.longHistorySampleCount && long.concPGmL_E2.every(Number.isFinite);
        metricsMs[`longHistoryEventLoopDelay${i}`] = await nextTurn;
        const calibrationStart = performance.now();
        const calibrationTurn = new Promise<number>(resolve =>
            setTimeout(() => resolve(performance.now() - calibrationStart), 0),
        );
        const calibration = mcmcReference();
        checks[`repeatMcmc${i}`] = Object.entries(fixture.reference.calibration).every(
            ([key, value]) => Math.abs(calibration[key as keyof typeof calibration] - value) <= 1e-8,
        );
        metricsMs[`mcmc${i}`] = performance.now() - calibrationStart;
        metricsMs[`mcmcEventLoopDelay${i}`] = await calibrationTurn;
    }
    return { checks, metricsMs };
}
