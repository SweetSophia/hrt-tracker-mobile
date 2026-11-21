import { afterEach, expect, it, vi } from 'vitest';
import { executeForecastTask, type ForecastTaskCache } from '../../src/application/forecastTask';
import { validForecastOutput } from '../../src/application/forecastOutput';
import { projectForecast } from '../../src/application/forecastProjection';
import * as engine from '../../src/domain/engine';
import * as regimen from '../../src/utils/regimen';
import { forecastTaskInput } from './forecast-fixture';

const reference = (task: ReturnType<typeof forecastTaskInput>) => {
    const clock = Date.now;
    Date.now = () => task.nowMs;
    try {
        return projectForecast(task.request, new Map());
    } finally {
        Date.now = clock;
    }
};
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    engine.applyPKOverrides(null);
});
it.each([false, true])(
    'preserves complete current and plan values for mode masc=%s under the captured profile and clock',
    masc => {
        const task = forecastTaskInput(masc);
        const clock = Date.now;
        const before = engine.getActivePKParams();
        const actual = executeForecastTask(task);
        expect(actual).toEqual(reference(task));
        expect(structuredClone(actual)).toEqual(actual);
        expect(actual.current!.series.value.some(n => n > 0)).toBe(true);
        expect(actual.results['synthetic-a']!.band).not.toBeNull();
        expect(actual.results['synthetic-empty']).toBeNull();
        expect(Date.now).toBe(clock);
        expect(engine.getActivePKParams()).toEqual(before);
        expect(validForecastOutput(actual, task.request)).toBe(true);
    },
);
it('preserves empty-history results and the web first-fill cache across wall-clock changes', () => {
    const task = forecastTaskInput();
    const cache: ForecastTaskCache = new Map();
    task.nowMs += 900_000;
    const first = executeForecastTask(task, cache);
    expect(first.current!.series.timeH).toContain(task.nowMs / 3_600_000);
    expect(executeForecastTask(structuredClone(task), cache).current).toBe(first.current);
    const later = { ...task, nowMs: task.nowMs + 86_400_000 };
    const changed = executeForecastTask(later, cache);
    expect(changed.current).toBe(first.current);
    expect(changed.results['synthetic-a']).toBe(first.results['synthetic-a']);
    task.request.input.events = [];
    task.request.regimens = [];
    task.request.plans = [{ id: 'synthetic-empty', spec: null }];
    expect(executeForecastTask(task, cache)).toEqual({ current: null, results: { 'synthetic-empty': null } });
});
it('restores parameters and the original clock while hiding private exception details', () => {
    const clock = Date.now;
    engine.applyPKOverrides({ ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.07 });
    const before = engine.getActivePKParams();
    vi.spyOn(regimen, 'forecastPlan').mockImplementationOnce(() => {
        throw new Error('synthetic private record');
    });
    expect(() => executeForecastTask(forecastTaskInput())).toThrow('Model computation failed.');
    expect(Date.now).toBe(clock);
    expect(engine.getActivePKParams()).toEqual(before);
});
it('refuses renderer execution and invalid captured clocks', () => {
    const task = forecastTaskInput();
    expect(() => executeForecastTask({ ...task, nowMs: NaN })).toThrow('Invalid forecast task.');
    vi.stubGlobal('document', {});
    expect(() => executeForecastTask(task)).toThrow('Model tasks require a worker.');
});
it('rejects incomplete, nonfinite and wrong-plan batches instead of displaying partial curves', () => {
    const task = forecastTaskInput();
    const complete = executeForecastTask(task);
    for (const mutate of [
        (x: typeof complete) => {
            delete x.results['synthetic-a'];
        },
        (x: typeof complete) => {
            x.results.extra = null;
        },
        (x: typeof complete) => {
            x.current!.series.value.pop();
        },
        (x: typeof complete) => {
            x.results['synthetic-a']!.stats.peak = NaN;
        },
        (x: typeof complete) => {
            x.results['synthetic-a']!.band!.lo.pop();
        },
        (x: typeof complete) => {
            x.results['synthetic-a']!.range!.average = [1, Infinity];
        },
    ]) {
        const malformed = structuredClone(complete);
        mutate(malformed);
        expect(validForecastOutput(malformed, task.request)).toBe(false);
    }
});

it('rejects nonpositive schedule intervals before entering unbounded dose-generation loops', () => {
    for (const intervalH of [0, -1, NaN]) {
        const task = forecastTaskInput();
        task.request.plans[0].spec!.intervalH = intervalH;
        expect(() => executeForecastTask(task)).toThrow('Invalid forecast task.');
    }
});

it('preserves fitted MCMC uncertainty and an interior birth year under the captured clock', () => {
    const task = forecastTaskInput();
    task.request.input.birthYear = 1990;
    task.request.input.calibrationMethod = 'mcmc';
    task.request.input.fitErrPct = 25;
    task.request.input.labResults = [30, 8].map((age, i) => ({
        id: `synthetic-fit-${i}`,
        timeH: task.request.input.nowH - age,
        concValue: 80 + i * 20,
        unit: 'pg/ml' as const,
    }));
    const actual = executeForecastTask(task);
    expect(actual).toEqual(reference(task));
    expect(actual.results['synthetic-a']!.range).not.toBeNull();
    expect(actual.results['synthetic-a']!.runs).toBeGreaterThan(0);
});
