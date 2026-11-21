import {
    DEFAULT_PK_PARAMS,
    getActivePKParams,
    interpolateConcentration_E2,
    runSimulationWithParams,
    Route,
    Ester,
    type DoseEvent,
} from '../../src/domain/engine';
import type { EngineInput } from '../../src/application/engineProtocol';
import { createBundledEngineRunner } from '../../src/application/engineWorkerClient';
import fixture from '../../tests/fixtures/mobile/feasibility.json';
import { fixtureCases, frozen, NOW_H } from '../probe/reference';
import { checkReference } from '../probe/engine';

const input = (events: DoseEvent[]): EngineInput => ({
    events,
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    labs: [],
    calibrationMethod: 'off',
    historyMode: 'retrospective',
    nowMs: NOW_H * 3_600_000,
    sampleTimesH: [NOW_H],
});
export function mcmcInput(): EngineInput {
    const events: DoseEvent[] = [
        ...Array.from({ length: 12 }, (_, i) => ({
            id: `synthetic-week-${i}`,
            route: Route.injection,
            ester: Ester.EV,
            doseMG: 4,
            timeH: NOW_H - 48 - i * 168,
            extras: {},
        })),
        ...Array.from({ length: 30 }, (_, i) => ({
            id: `synthetic-day-${i}`,
            route: Route.oral,
            ester: Ester.E2,
            doseMG: 2,
            timeH: NOW_H - 6 - i * 24,
            extras: {},
        })),
    ];
    const sim = frozen(() => runSimulationWithParams(events, 70, DEFAULT_PK_PARAMS))!;
    return {
        ...input(events),
        calibrationMethod: 'mcmc',
        labs: [650, 480, 300, 150, 50, 24].map((age, i) => ({
            id: `synthetic-lab-${i}`,
            timeH: NOW_H - age,
            concValue: interpolateConcentration_E2(sim, NOW_H - age)! * 1.1,
            unit: 'pg/ml',
        })),
    };
}
const aborted = async (promise: Promise<unknown>) => {
    try {
        await promise;
        return false;
    } catch (error) {
        return error instanceof Error && error.name === 'AbortError';
    }
};

/** Synthetic actual-worker qualification; ordinary screen consumers remain unchanged. */
export function installEngineWorkerQualification() {
    Object.assign(window, {
        __hrtEngineWorkerQualification: {
            run: async () => {
                let measuring = false,
                    started = false,
                    ticks = 0,
                    maxGapMs = 0,
                    lastTick = 0,
                    workersCreated = 0;
                const runner = createBundledEngineRunner(worker => {
                    workersCreated++;
                    worker.addEventListener('message', event => {
                        if (measuring && event.data?.kind === 'started') {
                            started = true;
                            lastTick = performance.now();
                        }
                    });
                });
                const beforeParams = JSON.stringify(getActivePKParams()),
                    beforeClock = Date.now;
                runner.activate('synthetic/offline/local');
                let timer: ReturnType<typeof setInterval> | undefined;
                try {
                    const empty = await runner.calculate(input([]));
                    const curves: Record<string, unknown> = {};
                    for (const [name, events] of Object.entries(fixtureCases)) {
                        const sim = (await runner.calculate(input(events))).simulation!;
                        const indexes = Array.from(
                            new Set([
                                0,
                                ...Array.from({ length: 32 }, (_, i) => Math.floor((i * (sim.timeH.length - 1)) / 31)),
                            ]),
                        );
                        curves[name] = {
                            count: sim.timeH.length,
                            timeH: indexes.map(i => sim.timeH[i]),
                            e2PgMl: indexes.map(i => sim.concPGmL_E2[i]),
                            cpaNgMl: indexes.map(i => sim.concPGmL_CPA[i]),
                            testosteroneNgDl: indexes.map(i => sim.concNGdL_T[i]),
                        };
                    }
                    const custom = await runner.calculate({
                        ...input(fixtureCases.oral),
                        pkParams: { ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 },
                    });
                    const ordinary = await runner.calculate(input(fixtureCases.oral));
                    const parameterIsolation =
                        JSON.stringify(ordinary.simulation?.concPGmL_E2) ===
                            JSON.stringify(
                                (await runner.calculate(input(fixtureCases.oral))).simulation?.concPGmL_E2,
                            ) &&
                        Math.max(...custom.simulation!.concPGmL_E2) !== Math.max(...ordinary.simulation!.concPGmL_E2);
                    const heavy = mcmcInput();
                    measuring = true;
                    timer = setInterval(() => {
                        if (started) {
                            const now = performance.now();
                            maxGapMs = Math.max(maxGapMs, now - lastTick);
                            lastTick = now;
                            ticks++;
                        }
                    }, 5);
                    const begin = performance.now();
                    const calibrated = await runner.calculate(heavy);
                    const roundTripMs = performance.now() - begin;
                    if (started) maxGapMs = Math.max(maxGapMs, performance.now() - lastTick);
                    measuring = false;
                    clearInterval(timer);
                    timer = undefined;
                    const reference = checkReference({
                        empty: empty.simulation,
                        curves,
                        customPeakPgMl: Math.max(...custom.simulation!.concPGmL_E2),
                        calibration: {
                            scale: calibrated.calibration.scale,
                            factor: calibrated.factors[0],
                            kMul: calibrated.calibration.kMul,
                        },
                    });
                    const obsolete = aborted(runner.calculate(heavy));
                    const queued = aborted(runner.calculate(input(fixtureCases.oral)));
                    const latest = runner.calculate(input(fixtureCases.testosterone));
                    const newest = await latest;
                    const latestOnly =
                        (await obsolete) &&
                        (await queued) &&
                        newest.simulation !== null &&
                        newest.simulation.concNGdL_T.some(n => n > 0);
                    const controller = new AbortController();
                    const cancelled = aborted(runner.calculate(heavy, { signal: controller.signal }));
                    controller.abort();
                    const activeCancelled = await cancelled;
                    const stale = aborted(runner.calculate(heavy));
                    runner.activate('synthetic/offline/other');
                    const afterScope = await runner.calculate(input(fixtureCases.gel));
                    const scopeFenced =
                        (await stale) &&
                        afterScope.simulation !== null &&
                        afterScope.simulation.concNGdL_T.some(n => n > 0);
                    return {
                        checks: {
                            reference,
                            parameterIsolation,
                            cloneable: !!structuredClone(calibrated),
                            heartbeat: started && ticks > 0,
                            latestOnly,
                            activeCancelled,
                            scopeFenced,
                            uiParametersUnchanged: beforeParams === JSON.stringify(getActivePKParams()),
                            uiClockUnchanged: beforeClock === Date.now,
                        },
                        metrics: { ticks, maxGapMs, roundTripMs, workersCreated },
                        referenceCalibration: fixture.reference.calibration,
                    };
                } finally {
                    if (timer) clearInterval(timer);
                    runner.dispose();
                }
            },
        },
    });
}
