import { describe, expect, it } from 'vitest';
import { reportHistoryKey } from '../../src/application/reportHistoryKey';
import { Ester, Route } from '../../src/domain/types';
import type { DoseEvent, LabResult } from '../../src/domain/types';

const dose: DoseEvent = { id: 'dose', route: Route.injection, ester: Ester.EV, timeH: 500_000, doseMG: 4, extras: {} };
const lab: LabResult = { id: 'lab', timeH: 500_010, concValue: 100, unit: 'pg/ml' };
const patch: DoseEvent = { ...dose, id: 'patch', route: Route.patchApply, ester: Ester.E2 };
const removal: DoseEvent = {
    ...patch,
    id: 'removal',
    route: Route.patchRemove,
    timeH: 500_070,
    patchApplicationId: patch.id,
};
const history = {
    events: [dose, patch, removal],
    labs: [lab],
    weightKG: 70,
    birthYear: null,
    pkParams: null,
    calibrationMethod: 'ou_kalman',
    historyMode: 'forward',
} satisfies Parameters<typeof reportHistoryKey>[0];

describe('PDF model history identity', () => {
    it('ignores edits to sync metadata and identifiers unrelated to the plotted curve', () => {
        const refreshed = {
            ...history,
            events: [{ ...dose, id: 'synced-dose', updatedAt: 100 }, { ...patch, updatedAt: 100 }, removal],
            labs: [{ ...lab, id: 'synced-lab', updatedAt: 100 }],
        };
        expect(reportHistoryKey(refreshed)).toBe(reportHistoryKey(history));
    });

    it('distinguishes changed patch pairings and concentration inputs', () => {
        const key = reportHistoryKey(history);
        expect(
            reportHistoryKey({ ...history, events: [dose, patch, { ...removal, patchApplicationId: 'other' }] }),
        ).not.toBe(key);
        expect(reportHistoryKey({ ...history, events: [dose, { ...patch, id: 'other' }, removal] })).not.toBe(key);
        expect(reportHistoryKey({ ...history, events: [{ ...dose, doseMG: 5 }, patch, removal] })).not.toBe(key);
        expect(reportHistoryKey({ ...history, labs: [{ ...lab, assay: 'lcms' }] })).not.toBe(key);
    });
});
