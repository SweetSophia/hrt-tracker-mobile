import type { Scenario } from '../utils/regimen';
import type { ForecastTaskInput } from './engineProtocol';
import { projectForecast, type ForecastProjection } from './forecastProjection';

export type ForecastTaskCache = Map<string, Scenario | null>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reuse the web first-fill cache; a later clock only affects uncached scenarios. */
export function executeForecastTask(
    input: ForecastTaskInput,
    cache: ForecastTaskCache = new Map(),
): ForecastProjection {
    if (typeof document !== 'undefined') throw new Error('Model tasks require a worker.');
    const request = input?.request;
    const config = request?.input;
    if (
        !Number.isSafeInteger(input?.nowMs) ||
        input.nowMs <= 0 ||
        !config ||
        !Array.isArray(config.events) ||
        !Array.isArray(config.labResults) ||
        !finite(config.weight) ||
        !finite(config.nowH) ||
        !finite(config.horizonH) ||
        config.horizonH <= 0 ||
        !Array.isArray(request.regimens) ||
        !Array.isArray(request.plans) ||
        (request.pkParams !== null && (typeof request.pkParams !== 'object' || Array.isArray(request.pkParams))) ||
        request.regimens.some(
            r => !r || !finite(r.intervalH) || r.intervalH <= 0 || !finite(r.nextH) || r.nextH + r.intervalH <= r.nextH,
        ) ||
        request.plans.some(
            p =>
                !p ||
                typeof p.id !== 'string' ||
                !p.id ||
                (p.spec !== null &&
                    (!p.spec ||
                        !finite(p.spec.intervalH) ||
                        p.spec.intervalH <= 0 ||
                        !finite(p.spec.startH) ||
                        p.spec.startH + p.spec.intervalH <= p.spec.startH)),
        ) ||
        new Set(request.plans.map(p => p.id)).size !== request.plans.length
    )
        throw new Error('Invalid forecast task.');
    const clock = Date.now;
    try {
        Date.now = () => input.nowMs;
        return projectForecast(request, cache);
    } catch {
        throw new Error('Model computation failed.');
    } finally {
        Date.now = clock;
    }
}
