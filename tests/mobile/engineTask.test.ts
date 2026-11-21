import { afterEach, expect, it, vi } from 'vitest';
import { executeEngineTask } from '../../src/application/engineTask';
import type { EngineInput } from '../../src/application/engineProtocol';
import * as engine from '../../src/domain/engine';
import { fixtureCases, NOW_H, frozen } from '../../mobile/probe/reference';
const input = (events = fixtureCases.injection): EngineInput => ({
    events,
    weightKG: 70,
    birthYear: 1980,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: NOW_H * 3_600_000,
    sampleTimesH: [NOW_H - 180, NOW_H - 40, NOW_H],
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    engine.applyPKOverrides(null);
});
it('preserves both modes, routes, explicit clock and custom parameters with cloneable results', () => {
    for (const events of [[], ...Object.values(fixtureCases)])
        for (const params of [null, { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 }]) {
            const request = { ...input(events), pkParams: params };
            const result = executeEngineTask(request);
            const expected = frozen(() =>
                engine.runSimulationWithParams(events, 70, params ?? engine.DEFAULT_PK_PARAMS, 1980),
            );
            expect(result.simulation).toEqual(expected);
            expect(result.sampleTimesH).toEqual(request.sampleTimesH);
            expect(result.factors).toEqual([1, 1, 1]);
            expect(result.factorSDs).toBeNull();
            expect(structuredClone(result)).toEqual(result);
        }
});
it.each(['off', 'ekf', 'ou_kalman', 'mipd', 'bayes', 'mcmc'] as const)(
    'preserves exact %s metadata and evaluated factors in both history modes',
    method => {
        const events = Array.from({ length: 5 }, (_, i) => ({
            ...fixtureCases.injection[0],
            id: `synthetic-${i}`,
            timeH: NOW_H - 48 - i * 168,
        }));
        const simulation = frozen(() => engine.runSimulationWithParams(events, 70, engine.DEFAULT_PK_PARAMS, 1980))!;
        const labs = [350, 180, 70].map((age, i) => ({
            id: `synthetic-lab-${i}`,
            timeH: NOW_H - age,
            concValue: engine.interpolateConcentration_E2(simulation, NOW_H - age)! * 1.1,
            unit: 'pg/ml' as const,
        }));
        for (const historyMode of ['forward', 'retrospective'] as const) {
            const request = { ...input(events), labs, calibrationMethod: method, historyMode };
            const actual = executeEngineTask(request);
            const direct = frozen(() =>
                engine.computeCalibration(simulation, events, 70, labs, method, historyMode, 1980),
            );
            const { factorFn, factorSdFn, ...metadata } = direct;
            expect(actual.calibration).toEqual(metadata);
            expect(actual.factors).toEqual(request.sampleTimesH.map(factorFn));
            expect(actual.factorSDs).toEqual(factorSdFn ? request.sampleTimesH.map(factorSdFn) : null);
            expect(structuredClone(actual)).toEqual(actual);
        }
    },
    30_000,
);
it('restores process parameters and clock after success and an engine failure', () => {
    engine.applyPKOverrides({ ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.09 });
    const before = engine.getActivePKParams(),
        clock = Date.now;
    executeEngineTask({ ...input(), pkParams: { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 } });
    expect(engine.getActivePKParams()).toEqual(before);
    expect(Date.now).toBe(clock);
    vi.spyOn(engine, 'computeCalibration').mockImplementationOnce(() => {
        throw new Error('synthetic sensitive payload');
    });
    expect(() => executeEngineTask(input())).toThrow('Model computation failed.');
    expect(engine.getActivePKParams()).toEqual(before);
    expect(Date.now).toBe(clock);
});
it('rejects invalid tasks and UI-thread execution without mutating process state', () => {
    const clock = Date.now;
    for (const change of [
        { nowMs: 0 },
        { nowMs: Infinity },
        { sampleTimesH: [NaN] },
        { weightKG: 0 },
        { calibrationMethod: 'unknown' },
        { historyMode: 'unknown' },
        { events: null },
        { birthYear: 1800 },
        { birthYear: new Date().getFullYear() + 1 },
    ])
        expect(() => executeEngineTask({ ...input(), ...change } as EngineInput)).toThrow('Invalid model task.');
    vi.stubGlobal('document', {});
    expect(() => executeEngineTask(input())).toThrow('Model tasks require a worker.');
    expect(Date.now).toBe(clock);
});
