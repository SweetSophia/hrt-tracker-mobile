import {
    computeCalibration,
    Ester,
    interpolateConcentration_E2,
    interpolateConcentration_T,
    Route,
    runSimulation,
    type DoseEvent,
    type LabResult,
} from '../../src/domain/engine';

const nowMs = Date.UTC(2025, 6, 1);
const nowH = nowMs / 3_600_000;
const sampleHours = [nowH - 96, nowH - 42, nowH - 12, nowH];
const labs: LabResult[] = [
    { id: 'synthetic-lab-1', timeH: nowH - 96, concValue: 120, unit: 'pg/ml' },
    { id: 'synthetic-lab-2', timeH: nowH - 42, concValue: 200, unit: 'pg/ml' },
    { id: 'synthetic-lab-3', timeH: nowH - 12, concValue: 160, unit: 'pg/ml' },
];

function injectionFixture(ester: Ester, doseMG: number): DoseEvent[] {
    return [336, 168, 48].map(hoursAgo => ({
        id: `synthetic-${ester}-${hoursAgo}`,
        route: Route.injection,
        ester,
        doseMG,
        timeH: nowH - hoursAgo,
        extras: {},
    }));
}

const estradiol = injectionFixture(Ester.EV, 4);
const testosterone = injectionFixture(Ester.TE, 50);
const profiles = [
    { name: 'neutral', weightKG: 70, birthYear: null },
    { name: 'weight', weightKG: 98, birthYear: null },
    { name: 'age', weightKG: 70, birthYear: 1985 },
    { name: 'ageAndWeight', weightKG: 98, birthYear: 1985 },
    { name: 'ageUnder19', weightKG: 70, birthYear: 2009 },
];

export function upstreamReference() {
    const clock = Date.now;
    Date.now = () => nowMs;
    try {
        const results = profiles.map(({ name, weightKG, birthYear }) => {
            const e2 = runSimulation(estradiol, weightKG, birthYear);
            const t = runSimulation(testosterone, weightKG, birthYear);
            if (!e2 || !t) throw new Error(`Missing model curve for ${name}`);
            const calibration = computeCalibration(e2, estradiol, weightKG, labs, 'mcmc', 'retrospective', birthYear);
            if (calibration.n !== labs.length) throw new Error(`Missing calibration observations for ${name}`);
            const e2PgMl = sampleHours.map(time => interpolateConcentration_E2(e2, time));
            const testosteroneNgDl = sampleHours.map(time => interpolateConcentration_T(t, time));
            const factors = sampleHours.map(calibration.factorFn);
            if (
                ![...e2PgMl, ...testosteroneNgDl, ...factors, calibration.scale, calibration.kMul].every(
                    Number.isFinite,
                )
            ) {
                throw new Error(`Invalid numerical output for ${name}`);
            }
            return {
                name,
                e2PgMl,
                testosteroneNgDl,
                calibration: {
                    scale: calibration.scale,
                    clearance: calibration.kMul,
                    factors,
                },
            };
        });
        return { inputs: { nowMs, sampleHours, profiles, estradiol, testosterone, labs }, results };
    } finally {
        Date.now = clock;
    }
}
