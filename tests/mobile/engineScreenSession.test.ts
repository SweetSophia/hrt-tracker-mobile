import { afterEach, expect, it, vi } from 'vitest';
import { EngineTaskCache } from '../../src/application/engineTaskCache';
import { executeEngineTask } from '../../src/application/engineTask';
import type { EngineInput } from '../../src/application/engineProtocol';
import * as engine from '../../src/domain/engine';
import { fixtureCases, NOW_H } from '../../mobile/probe/reference';

const input = (): EngineInput => ({
    events: fixtureCases.injection,
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [{ id: 'synthetic', timeH: NOW_H - 8, concValue: 100, unit: 'pg/ml' }],
    calibrationMethod: 'ou_kalman',
    historyMode: 'forward',
    nowMs: NOW_H * 3_600_000,
    sampleTimesH: [],
    screen: { nowMs: NOW_H * 3_600_000, regimens: null },
});
afterEach(() => {
    vi.restoreAllMocks();
    engine.applyPKOverrides(null);
});
it('reuses the baseline and fitted closure for readout ticks, and invalidates each dependency', () => {
    const cache = new EngineTaskCache();
    const simulate = vi.spyOn(engine, 'runSimulation');
    const calibrate = vi.spyOn(engine, 'computeCalibration');
    const request = input();
    const first = executeEngineTask(request, cache);
    const tick = executeEngineTask(
        { ...request, screen: { ...request.screen!, nowMs: request.nowMs + 60_000 } },
        cache,
    );
    expect(tick.simulation).toBe(first.simulation);
    expect(tick.screen!.nowMs).toBe(request.nowMs + 60_000);
    expect(tick.screen!.sampleTimesH).toContain((request.nowMs + 60_000) / 3_600_000);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(calibrate).toHaveBeenCalledTimes(1);
    executeEngineTask({ ...request, labs: request.labs.map(l => ({ ...l, concValue: 110 })) }, cache);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(calibrate).toHaveBeenCalledTimes(2);
    executeEngineTask({ ...request, pkParams: { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.05 } }, cache);
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(calibrate).toHaveBeenCalledTimes(3);
    executeEngineTask({ ...request, nowMs: request.nowMs + 120_000 }, cache);
    expect(simulate).toHaveBeenCalledTimes(3);
    expect(calibrate).toHaveBeenCalledTimes(4);
});
it.each(['off', 'ekf', 'ou_kalman', 'mipd', 'bayes', 'mcmc'] as const)(
    'matches uncached exact %s output, including custom parameters and forward lab discontinuities',
    calibrationMethod => {
        const request = {
            ...input(),
            events: fixtureCases.oral,
            calibrationMethod,
            pkParams: { ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.07 },
        };
        const cache = new EngineTaskCache();
        const before = engine.getActivePKParams();
        const clock = Date.now;
        const cached = executeEngineTask(request, cache);
        expect(cached).toEqual(executeEngineTask(request));
        expect(cached.screen!.sampleTimesH).toContain(request.labs[0].timeH);
        expect(structuredClone(cached)).toEqual(cached);
        expect(engine.getActivePKParams()).toEqual(before);
        expect(Date.now).toBe(clock);
    },
    30_000,
);
it('rejects invalid screen clocks or regimen shapes before changing worker globals', () => {
    for (const screen of [
        { nowMs: 0, regimens: null },
        { nowMs: NaN, regimens: [] },
        { nowMs: input().nowMs, regimens: {} },
    ])
        expect(() => executeEngineTask({ ...input(), screen } as EngineInput)).toThrow('Invalid model task.');
});
