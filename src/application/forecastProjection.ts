import { applyPKOverrides, getActivePKParams } from '../domain/engine';
import type { PKCustomParams } from '../domain/engine';
import { forecastCurrent, forecastPlan } from '../utils/regimen';
import type { ForecastInput, PlanSpec, Regimen, Scenario } from '../utils/regimen';

export interface ForecastRequest {
    input: ForecastInput;
    regimens: Regimen[];
    pkParams: PKCustomParams | null;
    plans: { id: string; spec: PlanSpec | null }[];
}
export interface ForecastProjection {
    current: Scenario | null;
    results: Record<string, Scenario | null>;
}

/** Existing synchronous forecasts, with one captured profile for the whole batch. */
export function projectForecast(request: ForecastRequest, cache: Map<string, Scenario | null>): ForecastProjection {
    const { input, regimens, pkParams, plans } = request;
    const inputKey = JSON.stringify([input, regimens, pkParams]);
    if (cache.size > 40) cache.clear();
    const before = getActivePKParams();
    try {
        applyPKOverrides(pkParams);
        const currentKey = JSON.stringify([inputKey, 'current']);
        if (!cache.has(currentKey)) cache.set(currentKey, forecastCurrent(input, regimens));
        const results: Record<string, Scenario | null> = {};
        for (const { id, spec } of plans) {
            if (!spec) {
                results[id] = null;
                continue;
            }
            const key = JSON.stringify([inputKey, spec]);
            if (!cache.has(key)) cache.set(key, forecastPlan(input, regimens, spec));
            results[id] = cache.get(key)!;
        }
        return { current: cache.get(currentKey)!, results };
    } finally {
        applyPKOverrides(before);
    }
}

export type ForecastCompute = (
    request: ForecastRequest,
    options?: { signal?: AbortSignal },
) => Promise<ForecastProjection>;
