import { useCallback, useEffect, useRef, useState } from 'react';
import {
    projectForecast,
    type ForecastCompute,
    type ForecastProjection,
    type ForecastRequest,
} from '../application/forecastProjection';
import type { AppModelStatus } from './appModelTypes';
import type { Scenario } from '../utils/regimen';
import { getBuildTarget } from '../platform/runtime';

const requiresWorker = getBuildTarget() === 'mobile';

/** Editor state lives in the page; only a complete matching calculation is published. */
export function useForecastProjection(
    request: ForecastRequest,
    modelStatus: AppModelStatus,
    compute?: ForecastCompute,
) {
    const cache = useRef(new Map<string, Scenario | null>());
    const key = JSON.stringify(request);
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => setAttempt(value => value + 1), []);
    const [published, setPublished] = useState<
        | (ForecastProjection & {
              key: string;
              attempt: number;
              compute?: ForecastCompute;
              failed?: boolean;
          })
        | null
    >(null);
    useEffect(() => {
        if (modelStatus !== 'ready') return;
        let active = true;
        const abort = new AbortController();
        const timer = window.setTimeout(async () => {
            try {
                if (requiresWorker && !compute) throw new Error('Forecast worker unavailable.');
                const projection = compute
                    ? await compute(request, { signal: abort.signal })
                    : projectForecast(request, cache.current);
                if (active) setPublished({ ...projection, key, attempt, compute });
            } catch {
                if (active) setPublished({ current: null, results: {}, key, attempt, compute, failed: true });
            }
        }, 280);
        return () => {
            active = false;
            window.clearTimeout(timer);
            abort.abort();
        };
    }, [request, key, modelStatus, compute, attempt]);
    const ready = modelStatus === 'ready';
    const matching = ready && published?.key === key && published.attempt === attempt && published.compute === compute;
    return {
        current: matching ? published.current : null,
        results: matching ? published.results : {},
        busy: modelStatus === 'pending' || (ready && !matching),
        failed: matching && published.failed,
        retry,
    };
}
