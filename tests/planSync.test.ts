import { describe, expect, it } from 'vitest';
import { applySyncedStateToStorage, buildExportPayloadFromStorage, modeKeyFor } from '../src/utils/backupState';
import { fingerprintState, hasContent, mergeSyncStates, normalizeSyncState } from '../src/utils/syncMerge';
import { Ester, Route } from '../logic';
import { MemoryStorage } from './memoryStorage';

const item = (id: string, doseMG: number) => ({
    id,
    route: Route.oral,
    ester: Ester.EV,
    doseMG,
    extras: {},
    everyDays: 1,
    timesPerDay: 2,
});

const active = { events: [], labResults: [], doseTemplates: [], weight: 70, birthYear: null, pkParams: null };

/** One device's storage, holding a plan stamped at `at` (0 = never stamped). */
const device = (plan: unknown[] | null, at = 0) => {
    const storage = new MemoryStorage();
    if (plan) storage.setItem(modeKeyFor('u1', 'transfem', 'plan'), JSON.stringify(plan));
    if (at) storage.setItem(modeKeyFor('u1', 'transfem', 'plan-at'), String(at));
    return storage;
};

const stateOf = (storage: MemoryStorage) =>
    normalizeSyncState(JSON.parse(JSON.stringify(buildExportPayloadFromStorage(storage, 'u1', 'transfem', active))));

describe('medication plan sync', () => {
    it('puts the plan in the sync payload', () => {
        const payload = buildExportPayloadFromStorage(device([item('a', 2)], 500), 'u1', 'transfem', active);
        expect(payload.modes.transfem.plan).toHaveLength(1);
        expect(payload.modes.transfem.planUpdatedAt).toBe(500);
        expect(payload.modes.transmasc.plan).toBeUndefined();
    });

    it('a new device with no plan takes the plan from the cloud', () => {
        const phone = stateOf(device(null));
        const cloud = stateOf(device([item('a', 2)], 500));
        expect(hasContent(cloud)).toBe(true);
        const result = mergeSyncStates(phone, cloud);
        expect(result.localChanged).toBe(true);
        expect(result.remoteStale).toBe(false);

        const storage = device(null);
        const applied = applySyncedStateToStorage(storage, 'u1', 'transfem', result.merged);
        expect(applied.active.plan?.map(i => i.id)).toEqual(['a']);
        expect(storage.getItem(modeKeyFor('u1', 'transfem', 'plan-at'))).toBe('500');
    });

    it('the newer edit wins, both ways', () => {
        const older = stateOf(device([item('a', 2)], 500));
        const newer = stateOf(device([item('a', 4)], 900));
        expect(mergeSyncStates(older, newer).merged.modes.transfem.plan?.[0].doseMG).toBe(4);
        expect(mergeSyncStates(newer, older).merged.modes.transfem.plan?.[0].doseMG).toBe(4);
    });

    it('clearing the plan reaches the other device', () => {
        const cleared = stateOf(device([], 900));
        const other = stateOf(device([item('a', 2)], 500));
        const merged = mergeSyncStates(other, cleared).merged;
        expect(merged.modes.transfem.plan).toEqual([]);
    });

    it('an untouched empty plan does not erase another device', () => {
        const empty = stateOf(device([]));
        expect(empty.modes.transfem.plan).toBeUndefined();
        const merged = mergeSyncStates(empty, stateOf(device([item('a', 2)]))).merged;
        expect(merged.modes.transfem.plan).toHaveLength(1);
    });

    it('a plan edit changes the fingerprint, so it gets pushed', () => {
        expect(fingerprintState(stateOf(device([item('a', 2)], 500)))).not.toBe(
            fingerprintState(stateOf(device([item('a', 4)], 500))),
        );
    });

    it('a cloud copy from an older build leaves the local plan alone', () => {
        const local = stateOf(device([item('a', 2)], 500));
        const old = normalizeSyncState({ modes: { transfem: { events: [] }, transmasc: { events: [] } } });
        const result = mergeSyncStates(local, old);
        expect(result.localChanged).toBe(false);
        expect(result.remoteStale).toBe(true);
    });
});

it('merges the newer patch removal reference and distinguishes numeric-looking record IDs', () => {
    const removal = { id: 'remove', route: 'patchRemove', ester: 'E2', timeH: 498272, doseMG: 0, extras: {} };
    const state = (target: string, updatedAt: number) =>
        normalizeSyncState({ events: [{ ...removal, patchApplicationId: target, updatedAt }] });
    const local = state('01', 1000);
    const remote = state('1', 2000);
    expect(fingerprintState(local)).not.toBe(fingerprintState(state('1', 1000)));
    expect(mergeSyncStates(local, remote).merged.modes.transfem.events[0].patchApplicationId).toBe('1');
});

const removalCopy = (patchApplicationId: string | undefined, updatedAt: number) => ({
    id: 'remove',
    route: 'patchRemove',
    ester: 'E2',
    timeH: 498272,
    doseMG: 0,
    extras: {},
    ...(patchApplicationId === undefined ? {} : { patchApplicationId }),
    updatedAt,
});

const removalState = (patchApplicationId: string | undefined, updatedAt: number) =>
    normalizeSyncState({ events: [removalCopy(patchApplicationId, updatedAt)] });

it('an old-client edit that drops the link keeps the recorded patch, both ways', () => {
    // An app without patch pairing rebuilds the edited removal without patchApplicationId,
    // and its newer stamp would otherwise win and leave the link stripped.
    const linked = removalState('01', 1000);
    const stripped = removalState(undefined, 2000);

    const pull = mergeSyncStates(stripped, linked);
    expect(pull.merged.modes.transfem.events[0].patchApplicationId).toBe('01');
    expect(pull.localChanged).toBe(true);
    expect(pull.remoteStale).toBe(false);
    expect(pull.stats.updated).toBe(1);

    const push = mergeSyncStates(linked, stripped);
    expect(push.merged.modes.transfem.events[0].patchApplicationId).toBe('01');
    expect(push.localChanged).toBe(false);
    expect(push.remoteStale).toBe(true);
    expect(push.stats.updated).toBe(1);
    expect(JSON.stringify(push.merged.modes.transfem.events)).toBe(JSON.stringify(pull.merged.modes.transfem.events));

    // Once the healed copy is applied and pushed, both sides hold the same
    // content: the next merge settles with nothing left to do.
    const settled = mergeSyncStates(push.merged, push.merged);
    expect(settled.localChanged).toBe(false);
    expect(settled.remoteStale).toBe(false);
    expect(settled.stats.updated).toBe(0);
});

it('respects an explicitly changed link and a changed hormone or route', () => {
    const relinked = removalState('02', 2000);
    expect(mergeSyncStates(removalState('01', 1000), relinked).merged.modes.transfem.events[0].patchApplicationId).toBe(
        '02',
    );

    const otherHormone = normalizeSyncState({ events: [{ ...removalCopy(undefined, 2000), ester: 'T' }] });
    const hormoneMerge = mergeSyncStates(removalState('01', 1000), otherHormone).merged;
    expect(hormoneMerge.modes.transfem.events[0].patchApplicationId).toBe('01');
    expect(hormoneMerge.modes.transmasc.events[0].patchApplicationId).toBeUndefined();

    const otherRoute = normalizeSyncState({
        events: [{ ...removalCopy(undefined, 2000), route: 'oral', ester: 'EV', doseMG: 2 }],
    });
    const routeMerge = mergeSyncStates(removalState('01', 1000), otherRoute).merged;
    expect(routeMerge.modes.transfem.events[0].route).toBe('oral');
    expect(routeMerge.modes.transfem.events[0].patchApplicationId).toBeUndefined();
});
