import type { DemoCompute } from '../application/demoProtocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBundledEngineRunner } from '../application/engineWorkerClient';
import type { ForecastCompute } from '../application/forecastProjection';
import type { EngineRunner } from '../application/engineRunner';
import type { EngineInput } from '../application/engineProtocol';
import { screenModelView, type AppModelView } from '../application/appModelView';
import type { AppModelInput, AppModelState } from './appModelTypes';

/** Snapshot identity fences the render before effects run, as well as late promises. */
export function useWorkerAppModel(props: AppModelInput): AppModelState {
    const {
        scope,
        events,
        weightKG,
        birthYear,
        pkParams,
        labs,
        calibrationMethod,
        historyMode,
        regimens,
        withPrediction,
        nowMs,
    } = props;
    const baseline = useMemo(
        () => ({ events, weightKG, birthYear, pkParams }),
        [events, weightKG, birthYear, pkParams],
    );
    const historyInputs = useMemo(
        () => ({ ...baseline, labs, calibrationMethod, historyMode }),
        [baseline, labs, calibrationMethod, historyMode],
    );
    const gridClock = useRef<{ baseline: typeof baseline; scope: AppModelInput['scope']; nowMs: number } | null>(null);
    const input = useMemo<Omit<EngineInput, 'nowMs'>>(
        () => ({
            ...historyInputs,
            sampleTimesH: [],
            screen: { nowMs, regimens: withPrediction ? regimens : null },
        }),
        [historyInputs, nowMs, regimens, withPrediction],
    );
    const runnerRef = useRef<EngineRunner | null>(null);
    const runnerScope = useRef<AppModelInput['scope'] | null>(null);
    const runForecast = useCallback<ForecastCompute>(
        (request, options) => {
            const runner = runnerRef.current;
            if (!runner || runnerScope.current !== scope)
                return Promise.reject(Object.assign(new Error('Model computation cancelled.'), { name: 'AbortError' }));
            return runner.forecast({ request, nowMs: Date.now() }, options);
        },
        [scope],
    );
    const runDemo = useCallback<DemoCompute>(
        (request, options) => {
            const runner = runnerRef.current;
            if (!runner || runnerScope.current !== scope)
                return Promise.reject(Object.assign(new Error('Model computation cancelled.'), { name: 'AbortError' }));
            return runner.demo({ request, nowMs: Date.now(), pkParams }, options);
        },
        [scope, pkParams],
    );
    const [attempt, setAttempt] = useState(0);
    const retryModel = useCallback(() => setAttempt(value => value + 1), []);
    const [result, setResult] = useState<{
        input: typeof input;
        historyInputs: typeof historyInputs;
        scope: AppModelInput['scope'];
        attempt: number;
        view?: AppModelView;
        failed?: boolean;
    } | null>(null);
    useEffect(() => {
        const runner = createBundledEngineRunner();
        runner.activate(JSON.stringify([scope.backend, scope.owner, scope.mode]));
        runnerRef.current = runner;
        runnerScope.current = scope;
        return () => {
            if (runnerRef.current === runner) {
                runnerRef.current = null;
                runnerScope.current = null;
            }
            runner.dispose();
        };
    }, [scope]);
    useEffect(() => {
        const runner = runnerRef.current;
        if (!runner) return;
        let active = true;
        const abort = new AbortController();
        // Capture the external clock in the effect, and retain it for readout-only ticks.
        if (gridClock.current?.baseline !== baseline || gridClock.current.scope !== scope)
            gridClock.current = { baseline, scope, nowMs: Date.now() };
        void runner
            .calculate({ ...input, nowMs: gridClock.current.nowMs }, { signal: abort.signal })
            .then(output => {
                if (active) setResult({ input, historyInputs, scope, attempt, view: screenModelView(output) });
            })
            .catch(() => {
                if (active) setResult({ input, historyInputs, scope, attempt, failed: true });
            });
        return () => {
            active = false;
            abort.abort();
        };
    }, [input, baseline, historyInputs, scope, attempt]);
    const matchingHistory =
        result?.historyInputs === historyInputs && result.scope === scope && result.attempt === attempt;
    const matching = matchingHistory && result.input === input;
    const reportModel = matchingHistory ? result.view : undefined;
    if (matching && result.view)
        return { ...result.view, modelStatus: 'ready', reportModel, retryModel, runForecast, runDemo };
    return {
        simulation: null,
        simulationAhead: null,
        calibration: {
            method: calibrationMethod,
            scale: 1,
            kMul: 1,
            halfLifeDeltaPct: 0,
            n: 0,
            fitErrPct: null,
            points: [],
            factorFn: () => {
                throw new Error('Model sample unavailable.');
            },
        },
        modelStatus: matching && result.failed ? 'error' : 'pending',
        reportModel,
        retryModel,
        runForecast,
        runDemo,
    };
}
