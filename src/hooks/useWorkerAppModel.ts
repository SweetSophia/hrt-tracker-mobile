import type { DemoCompute } from '../application/demoProtocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBundledEngineRunner } from '../application/engineWorkerClient';
import type { ForecastCompute } from '../application/forecastProjection';
import type { EngineRunner } from '../application/engineRunner';
import type { EngineInput } from '../application/engineProtocol';
import { screenModelView, type AppModelView } from '../application/appModelView';
import { reportHistoryKey } from '../application/reportHistoryKey';
import type { AppModelInput, AppModelState } from './appModelTypes';

const REPORT_MAX_AGE_MS = 2 * 60_000;

function recentReportView(view: AppModelView | undefined, nowMs: number): AppModelView | undefined {
    if (view?.modelNowMs === undefined) return undefined;
    const ageMs = nowMs - view.modelNowMs;
    return ageMs >= 0 && ageMs < REPORT_MAX_AGE_MS ? view : undefined;
}

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
    // A storage commit can reparse unchanged events and labs into new arrays.
    const historyKey = useMemo(() => reportHistoryKey(historyInputs), [historyInputs]);
    const scopeKey = JSON.stringify([scope.backend, scope.owner, scope.mode]);
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
    const reportHistory = useMemo(() => ({ historyKey, scopeKey }), [historyKey, scopeKey]);
    const [result, setResult] = useState<{
        input: typeof input;
        scope: AppModelInput['scope'];
        attempt: number;
        reportHistory: typeof reportHistory;
        lastSuccess?: AppModelView;
        failed: boolean;
    } | null>(null);
    useEffect(() => {
        const runner = createBundledEngineRunner();
        runner.activate(scopeKey);
        runnerRef.current = runner;
        runnerScope.current = scope;
        return () => {
            if (runnerRef.current === runner) {
                runnerRef.current = null;
                runnerScope.current = null;
            }
            runner.dispose();
        };
    }, [scope, scopeKey]);
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
                if (active)
                    setResult({
                        input,
                        scope,
                        attempt,
                        reportHistory,
                        lastSuccess: screenModelView(output),
                        failed: false,
                    });
            })
            .catch(() => {
                if (active)
                    setResult(previous => ({
                        input,
                        scope,
                        attempt,
                        reportHistory,
                        lastSuccess:
                            previous?.reportHistory === reportHistory
                                ? recentReportView(previous.lastSuccess, nowMs)
                                : undefined,
                        failed: true,
                    }));
            });
        return () => {
            active = false;
            abort.abort();
        };
    }, [input, baseline, scope, attempt, reportHistory, nowMs]);
    const matching = result?.input === input && result.scope === scope && result.attempt === attempt;
    // Retry starts a new request but does not change what the accepted report estimated.
    const reportModel =
        result?.reportHistory === reportHistory ? recentReportView(result.lastSuccess, nowMs) : undefined;
    if (matching && !result.failed && result.lastSuccess)
        return { ...result.lastSuccess, modelStatus: 'ready', reportModel, retryModel, runForecast, runDemo };
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
