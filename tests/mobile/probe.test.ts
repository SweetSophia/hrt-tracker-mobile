import { expect, it } from 'vitest';
import fixture from '../fixtures/mobile/feasibility.json';
import { checkReference, engineProbe } from '../../mobile/probe/engine';
import { modelReference } from '../../mobile/probe/reference';

it('matches the unchanged web model reference, including units and calibration', () => {
    expect(checkReference(modelReference())).toBe(true);
}, 30_000);

it('rejects changed concentrations, missing samples, and nonfinite values', () => {
    for (const mutate of [
        (r: typeof fixture.reference) => {
            r.curves.oral.e2PgMl[3] += 1;
        },
        (r: typeof fixture.reference) => {
            r.curves.oral.timeH.pop();
        },
        (r: typeof fixture.reference) => {
            r.calibration.scale = NaN;
        },
    ]) {
        const reference = structuredClone(fixture.reference);
        mutate(reference);
        expect(checkReference(reference)).toBe(false);
    }
});

it('checks the capped base grid plus the model additional event samples', async () => {
    const report = await engineProbe();
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
}, 30_000);
