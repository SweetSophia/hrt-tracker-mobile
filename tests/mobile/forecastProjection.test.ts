import { afterEach, expect, it, vi } from 'vitest';
import { projectForecast, type ForecastRequest } from '../../src/application/forecastProjection';
import * as engine from '../../src/domain/engine';
import * as regimen from '../../src/utils/regimen';
import { fixtureCases, frozen, NOW_H } from '../../mobile/probe/reference';

const request = (): ForecastRequest => {
    const events = [6, 30, 54].map((age, index) => ({
        ...fixtureCases.oral[0],
        id: `synthetic-${index}`,
        timeH: NOW_H - age,
    }));
    return {
        input: {
            events,
            weight: 70,
            birthYear: null,
            labResults: [],
            calibrationMethod: 'off',
            calibrationHistoryMode: 'forward',
            isTransmasc: false,
            nowH: NOW_H,
            horizonH: 4 * 7 * 24,
            target: { low: 100, high: 200 },
            fitErrPct: null,
        },
        pkParams: null,
        regimens: regimen.detectRegimens(events, NOW_H),
        plans: [
            {
                id: 'synthetic-a',
                spec: {
                    route: engine.Route.oral,
                    ester: engine.Ester.E2,
                    doseMG: 2,
                    intervalH: 24,
                    startH: NOW_H + 6,
                    replace: true,
                    extras: {},
                },
            },
        ],
    };
};
afterEach(() => {
    vi.restoreAllMocks();
    engine.applyPKOverrides(null);
});
it('publishes the same current/plan calculations together under captured parameters', () => {
    const r = request();
    r.pkParams = { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 };
    const actual = frozen(() => projectForecast(r, new Map()));
    const before = engine.getActivePKParams();
    engine.applyPKOverrides(r.pkParams);
    try {
        expect(actual.current).toEqual(frozen(() => regimen.forecastCurrent(r.input, r.regimens)));
        expect(actual.results['synthetic-a']).toEqual(
            frozen(() => regimen.forecastPlan(r.input, r.regimens, r.plans[0].spec!)),
        );
    } finally {
        engine.applyPKOverrides(before);
    }
});
it('reuses equivalent inputs and invalidates same-length dose edits and PK profile changes', () => {
    const cache = new Map<string, regimen.Scenario | null>();
    const firstInput = request();
    const first = frozen(() => projectForecast(firstInput, cache));
    expect(frozen(() => projectForecast(structuredClone(firstInput), cache)).current).toBe(first.current);
    const changed = structuredClone(firstInput);
    changed.input.events[0].doseMG *= 2;
    const next = frozen(() => projectForecast(changed, cache));
    expect(next.current).not.toBe(first.current);
    expect(next.current!.series.value).not.toEqual(first.current!.series.value);
    const custom = frozen(() =>
        projectForecast({ ...firstInput, pkParams: { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 } }, cache),
    );
    expect(custom.results['synthetic-a']!.series.value).not.toEqual(first.results['synthetic-a']!.series.value);
});
it('restores the current UI parameters even when a captured scenario computation throws', () => {
    engine.applyPKOverrides({ ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.07 });
    const before = engine.getActivePKParams();
    vi.spyOn(regimen, 'forecastPlan').mockImplementationOnce(() => {
        throw new Error('synthetic failure');
    });
    expect(() => frozen(() => projectForecast(request(), new Map()))).toThrow('synthetic failure');
    expect(engine.getActivePKParams()).toEqual(before);
});
