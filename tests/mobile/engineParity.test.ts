import { afterEach, expect, it, vi } from 'vitest';
import * as legacy from '../../logic';
import * as engine from '../../src/domain/engine';
import * as shbg from '../../shbg';
import { fixtureCases, NOW_H } from '../../mobile/probe/reference';

const cryptoExports = new Set([
    'decompressData',
    'encryptData',
    'decryptData',
    'deriveCloudKey',
    'isCloudEncrypted',
    'encryptCloudPayload',
    'decryptCloudPayload',
]);
afterEach(() => vi.restoreAllMocks());

it('preserves the numerical API by reference while excluding the crypto API', () => {
    expect(Object.keys(engine).sort()).toEqual(
        [...new Set([...Object.keys(legacy).filter(name => !cryptoExports.has(name)), ...Object.keys(shbg)])].sort(),
    );
    for (const [name, value] of Object.entries(legacy)) {
        if (!cryptoExports.has(name)) expect(engine[name as keyof typeof engine]).toBe(value);
    }
    for (const [name, value] of Object.entries(shbg)) expect(engine[name as keyof typeof engine]).toBe(value);
});

it('matches legacy curves across modes, routes, custom parameters, age and unsupported records', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_H * 3_600_000);
    const seed = fixtureCases.oral[0];
    const cases: legacy.DoseEvent[][] = [
        [],
        ...Object.values(fixtureCases),
        [{ ...seed, route: legacy.Route.sublingual }],
        [...fixtureCases.patch, { ...seed, route: legacy.Route.patchRemove, timeH: NOW_H - 12, doseMG: 0 }],
        [{ ...seed, ester: legacy.Ester.SPIRO }],
        [{ ...seed, ester: 'unknown' as legacy.Ester }],
    ];
    for (const events of cases) {
        expect(engine.runSimulation(events, 70, 1980)).toEqual(legacy.runSimulation(events, 70, 1980));
        expect(
            engine.runSimulationWithParams(events, 70, { ...legacy.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 }, 1980),
        ).toEqual(legacy.runSimulationWithParams(events, 70, { ...legacy.DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 }, 1980));
    }
    for (const unit of ['pg/ml', 'pmol/l', 'ng/dl', 'nmol/l'] as const) {
        expect(engine.convertToPgMl(100, unit)).toEqual(legacy.convertToPgMl(100, unit));
        expect(engine.convertToNgDl(100, unit)).toEqual(legacy.convertToNgDl(100, unit));
    }
});

it.each(['off', 'ekf', 'ou_kalman', 'mipd', 'bayes', 'mcmc'] as const)(
    'preserves %s calibration and its time-dependent factors',
    method => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW_H * 3_600_000);
        // Existing MCMC implementation seeds its PRNG internally from the data.
        const events = Array.from({ length: 5 }, (_, i) => ({
            ...fixtureCases.injection[0],
            id: `synthetic-${i}`,
            timeH: NOW_H - 48 - i * 168,
        }));
        const sim = legacy.runSimulation(events, 70, 1980)!;
        const labs = [350, 180, 70].map((age, i) => ({
            id: `synthetic-lab-${i}`,
            timeH: NOW_H - age,
            concValue: legacy.interpolateConcentration_E2(sim, NOW_H - age)! * 1.1,
            unit: 'pg/ml' as const,
        }));
        for (const history of ['forward', 'retrospective'] as const) {
            const before = legacy.computeCalibration(sim, events, 70, labs, method, history, 1980);
            const after = engine.computeCalibration(sim, events, 70, labs, method, history, 1980);
            const { factorFn: oldFactor, factorSdFn: oldSd, ...oldValues } = before;
            const { factorFn: newFactor, factorSdFn: newSd, ...newValues } = after;
            expect(newValues).toEqual(oldValues);
            for (const time of [NOW_H - 400, NOW_H - 180, NOW_H]) {
                expect(newFactor(time)).toBe(oldFactor(time));
                expect(newSd?.(time)).toBe(oldSd?.(time));
            }
        }
    },
    30_000,
);
