import { expect, it } from 'vitest';
import { screenModelView } from '../../src/application/appModelView';
import type { EngineOutput } from '../../src/application/engineProtocol';

const output = (): EngineOutput => ({
    simulation: null,
    calibration: {
        method: 'bayes',
        scale: 1.2,
        kMul: 1,
        halfLifeDeltaPct: 0,
        n: 1,
        fitErrPct: 0,
        points: [{ id: 'synthetic', timeH: 2, obs: 100, pred: 80, ratio: 1.25 }],
    },
    sampleTimesH: [],
    factors: [],
    factorSDs: null,
    screen: {
        nowMs: 3_600_000,
        simulationAhead: null,
        sampleTimesH: [1, 2, 2.0000000001],
        factors: [1, 1.8, 2.3],
        factorSDs: [0.1, 0.2, 0.3],
    },
});
it('presents the exact worker entries and metadata without interpolating neighboring times', () => {
    const raw = output();
    const view = screenModelView(raw);
    expect(view.modelNowMs).toBe(raw.screen!.nowMs);
    expect(view.calibration.points).toEqual(raw.calibration.points);
    expect(view.calibration.factorFn(2)).toBe(1.8);
    expect(view.calibration.factorFn(2.0000000001)).toBe(2.3);
    expect(view.calibration.factorSdFn!(2)).toBe(0.2);
    expect(() => view.calibration.factorFn(2.00000000005)).toThrow('Model sample unavailable.');
    expect(() => view.calibration.factorFn(NaN)).toThrow('Model sample unavailable.');
});
it('does not invent an uncertainty function when the model supplies none', () => {
    const raw = output();
    raw.screen!.factorSDs = null;
    expect(screenModelView(raw).calibration.factorSdFn).toBeUndefined();
});
it('rejects incomplete, conflicting and nonfinite tables rather than showing default estimates', () => {
    for (const mutate of [
        (v: EngineOutput) => {
            delete v.screen;
        },
        (v: EngineOutput) => {
            v.screen!.factors.pop();
        },
        (v: EngineOutput) => {
            v.screen!.factors[0] = Infinity;
        },
        (v: EngineOutput) => {
            v.screen!.sampleTimesH[2] = 2;
        },
        (v: EngineOutput) => {
            v.screen!.sampleTimesH[1] = 4;
        },
    ]) {
        const raw = output();
        mutate(raw);
        expect(() => screenModelView(raw)).toThrow('Invalid model screen.');
    }
});
