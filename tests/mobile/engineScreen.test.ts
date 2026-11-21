import { afterEach, expect, it, vi } from 'vitest';
import { projectEngineScreen, type EngineScreenCache } from '../../src/application/engineScreen';
import { screenSampleTimes } from '../../src/application/engineScreenSamples';
import type { EngineInput } from '../../src/application/engineProtocol';
import * as engine from '../../src/domain/engine';
import { detectRegimens, dosesAhead } from '../../src/utils/regimen';
import { fixtureCases, NOW_H, frozen } from '../../mobile/probe/reference';

const input = (events = fixtureCases.injection): EngineInput => ({
    events,
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'forward',
    nowMs: NOW_H * 3_600_000,
    sampleTimesH: [NOW_H, NOW_H],
    screen: { nowMs: NOW_H * 3_600_000, regimens: null },
});
const fit = (): engine.CalibrationResult => ({
    method: 'ou_kalman',
    scale: 1,
    kMul: 1,
    halfLifeDeltaPct: 0,
    n: 0,
    fitErrPct: null,
    points: [],
    factorFn: h => (h < NOW_H - 8.123 ? 1 : 2),
    factorSdFn: h => (h < NOW_H - 8.123 ? 0.1 : 0.2),
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    engine.applyPKOverrides(null);
});
it('uses a deterministic unique union, including times not on either curve grid', () => {
    const request = input();
    request.labs = [{ id: 'synthetic', timeH: NOW_H - 8.123, concValue: 100, unit: 'pg/ml' }];
    const simulation = frozen(() => engine.runSimulation(request.events, 70));
    const result = projectEngineScreen(request, simulation, fit());
    expect(result.sampleTimesH).toEqual(screenSampleTimes(request, simulation, null));
    expect(new Set(result.sampleTimesH).size).toBe(result.sampleTimesH.length);
    expect(result.sampleTimesH).toContain(request.labs[0].timeH);
    expect(result.factors).toEqual(result.sampleTimesH.map(fit().factorFn));
    expect(result.factorSDs).toEqual(result.sampleTimesH.map(fit().factorSdFn!));
    expect(result.factors[result.sampleTimesH.indexOf(request.labs[0].timeH)]).toBe(2);
});
it('projects empty and prediction-disabled models without inventing a curve or SD function', () => {
    const request = input([]);
    const calibration = fit();
    delete calibration.factorSdFn;
    const result = projectEngineScreen(request, null, calibration);
    expect(result.simulationAhead).toBeNull();
    expect(result.factorSDs).toBeNull();
    expect(result.sampleTimesH).toEqual([NOW_H]);
});
it.each([{ fixture: fixtureCases.injection }, { fixture: fixtureCases.testosterone }])(
    'preserves exact prediction construction in either mode',
    ({ fixture }) => {
        const events = [0, 1, 2].map(i => ({ ...fixture[0], id: `synthetic-${i}`, timeH: NOW_H - 48 - i * 168 }));
        const request = input(events);
        request.screen!.regimens = detectRegimens(events, NOW_H);
        const simulation = frozen(() => engine.runSimulation(events, 70))!;
        const doses = dosesAhead(request.screen!.regimens, NOW_H, simulation.timeH.at(-1)!);
        expect(doses.length).toBeGreaterThan(0);
        const fromH = Math.min(...doses.map(e => e.timeH)) - 120 * 24;
        const expected = frozen(() => engine.runSimulation([...events.filter(e => e.timeH >= fromH), ...doses], 70));
        const actual = projectEngineScreen(request, simulation, fit());
        expect(actual.simulationAhead).toEqual(expected);
        for (const h of expected!.timeH) expect(actual.sampleTimesH).toContain(h);
    },
);
it('retains the prediction grid when a readout tick generates identical doses', () => {
    const events = [0, 1, 2].map(i => ({
        ...fixtureCases.injection[0],
        id: `synthetic-${i}`,
        timeH: NOW_H - 48 - i * 168,
    }));
    const request = input(events);
    request.screen!.regimens = detectRegimens(events, NOW_H);
    const simulation = frozen(() => engine.runSimulation(events, 70))!;
    const cache: EngineScreenCache = {};
    const first = projectEngineScreen(request, simulation, fit(), cache);
    const tick = projectEngineScreen(
        { ...request, screen: { ...request.screen!, nowMs: request.screen!.nowMs + 60_000 } },
        simulation,
        fit(),
        cache,
    );
    expect(tick.simulationAhead).toBe(first.simulationAhead);
    const next = projectEngineScreen(
        { ...request, screen: { ...request.screen!, nowMs: request.screen!.nowMs + 168 * 3_600_000 } },
        simulation,
        fit(),
        cache,
    );
    expect(next.simulationAhead).not.toBe(first.simulationAhead);
    projectEngineScreen({ ...request, screen: { ...request.screen!, regimens: null } }, simulation, fit(), cache);
    expect(cache.prediction).toBeUndefined();
});
it('restores the prediction clock after a failed simulation and rejects UI execution', () => {
    const events = [0, 1, 2].map(i => ({
        ...fixtureCases.injection[0],
        id: `synthetic-${i}`,
        timeH: NOW_H - 48 - i * 168,
    }));
    const request = input(events);
    request.screen!.regimens = detectRegimens(events, NOW_H);
    const simulation = frozen(() => engine.runSimulation(events, 70));
    const clock = Date.now;
    vi.spyOn(engine, 'runSimulation').mockImplementationOnce(() => {
        throw new Error('synthetic prediction failure');
    });
    expect(() => projectEngineScreen(request, simulation, fit())).toThrow('synthetic prediction failure');
    expect(Date.now).toBe(clock);
    vi.stubGlobal('document', {});
    expect(() => projectEngineScreen(request, simulation, fit())).toThrow('Model tasks require a worker.');
});

it('invalidates a prediction when only generated-dose pharmacokinetic extras change', () => {
    const events = [0, 1, 2].map(i => ({
        ...fixtureCases.oral[0],
        id: `synthetic-gel-${i}`,
        route: engine.Route.gel,
        timeH: NOW_H - 12 - i * 24,
        extras: { [engine.ExtraKey.gelSite]: 0 },
    }));
    const request = input(events);
    request.screen!.regimens = detectRegimens(events, NOW_H);
    const simulation = frozen(() => engine.runSimulation(events, 70))!;
    const cache: EngineScreenCache = {};
    const first = projectEngineScreen(request, simulation, fit(), cache);
    const changed = {
        ...request,
        screen: {
            ...request.screen!,
            regimens: request.screen!.regimens!.map(regimen => ({
                ...regimen,
                extras: { ...regimen.extras, [engine.ExtraKey.gelSite]: 2 },
            })),
        },
    };
    const expected = projectEngineScreen(changed, simulation, fit());
    expect(expected.simulationAhead).not.toEqual(first.simulationAhead);
    const actual = projectEngineScreen(changed, simulation, fit(), cache);
    expect(actual.simulationAhead).not.toBe(first.simulationAhead);
    expect(actual.simulationAhead).toEqual(expected.simulationAhead);
});
