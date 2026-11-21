import {
    DEFAULT_PK_PARAMS,
    computeCalibration,
    interpolateConcentration_E2,
    Ester,
    ExtraKey,
    Route,
    runSimulation,
    runSimulationWithParams,
    type DoseEvent,
} from '../../src/domain/engine';

export const NOW_H = 480_000;
const event = (id: string, route: Route, ester: Ester, doseMG: number, timeH: number, extras = {}): DoseEvent => ({
    id,
    route,
    ester,
    doseMG,
    timeH,
    extras,
});
export const fixtureCases = {
    injection: [event('synthetic-ev', Route.injection, Ester.EV, 4, NOW_H - 72)],
    oral: [event('synthetic-oral', Route.oral, Ester.E2, 2, NOW_H - 10)],
    cpa: [event('synthetic-cpa', Route.oral, Ester.CPA, 12.5, NOW_H - 10)],
    patch: [
        event('synthetic-patch', Route.patchApply, Ester.E2, 0.1, NOW_H - 48, {
            [ExtraKey.releaseRateUGPerDay]: 100,
            [ExtraKey.patchWearH]: 72,
        }),
    ],
    testosterone: [event('synthetic-t', Route.injection, Ester.TE, 50, NOW_H - 72)],
    gel: [event('synthetic-gel', Route.gel, Ester.T, 25, NOW_H - 10)],
};

export function frozen<T>(run: () => T): T {
    const now = Date.now;
    Date.now = () => NOW_H * 3_600_000;
    try {
        return run();
    } finally {
        Date.now = now;
    }
}

export function modelReference() {
    return frozen(() => {
        const curves = Object.fromEntries(
            Object.entries(fixtureCases).map(([name, events]) => {
                const sim = runSimulation(events, 70)!;
                const indexes = Array.from(
                    new Set([
                        0,
                        ...Array.from({ length: 32 }, (_, i) => Math.floor((i * (sim.timeH.length - 1)) / 31)),
                    ]),
                );
                return [
                    name,
                    {
                        count: sim.timeH.length,
                        timeH: indexes.map(i => sim.timeH[i]),
                        e2PgMl: indexes.map(i => sim.concPGmL_E2[i]),
                        cpaNgMl: indexes.map(i => sim.concPGmL_CPA[i]),
                        testosteroneNgDl: indexes.map(i => sim.concNGdL_T[i]),
                    },
                ];
            }),
        );
        const custom = runSimulationWithParams(fixtureCases.oral, 70, { ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 })!;
        return {
            empty: runSimulation([], 70),
            curves,
            customPeakPgMl: Math.max(...custom.concPGmL_E2),
            calibration: mcmcReference(),
        };
    });
}

export function mcmcReference() {
    return frozen(() => {
        const events = [
            ...Array.from({ length: 12 }, (_, i) =>
                event(`synthetic-week-${i}`, Route.injection, Ester.EV, 4, NOW_H - 48 - i * 168),
            ),
            ...Array.from({ length: 30 }, (_, i) =>
                event(`synthetic-day-${i}`, Route.oral, Ester.E2, 2, NOW_H - 6 - i * 24),
            ),
        ];
        const sim = runSimulation(events, 70)!;
        const labs = [650, 480, 300, 150, 50, 24].map((age, i) => ({
            id: `synthetic-lab-${i}`,
            timeH: NOW_H - age,
            concValue: interpolateConcentration_E2(sim, NOW_H - age)! * 1.1,
            unit: 'pg/ml' as const,
        }));
        const calibration = computeCalibration(sim, events, 70, labs, 'mcmc');
        return { scale: calibration.scale, factor: calibration.factorFn(NOW_H), kMul: calibration.kMul };
    });
}

export function longHistory() {
    return frozen(() => runSimulation([event('synthetic-long', Route.injection, Ester.EV, 4, NOW_H - 110_000)], 70)!);
}
