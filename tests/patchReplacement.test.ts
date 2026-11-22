import { describe, expect, it } from 'vitest';
import { Ester, ExtraKey, Route, type DoseEvent } from '../src/domain/types';
import {
    patchEntriesWithReplacements,
    patchRemovalPairs,
    patchRemovalTimes,
    resolvePatchWearH,
} from '../src/domain/shared/patch';
import { modeKeyFor, sanitizeImportedEvents } from '../src/utils/backupState';
import {
    buildCompleteBackupBundleReportFromStorage,
    inspectCompleteBackupBundle,
    mergeCompleteBackupBundleToStorage,
    type CompleteBackupActive,
    type CompleteBackupContext,
} from '../src/utils/backupBundle';
import type { ModeKey } from '../src/utils/syncMerge';
import { MemoryStorage } from './memoryStorage';

const T0 = 480_000;
const RATE = { [ExtraKey.releaseRateUGPerDay]: 100 };
const OWNER = 'local';
const MODE: ModeKey = 'transfem';
const CREATED_AT = '2030-01-01T00:00:00.000Z';
const NOW = Date.UTC(2030, 0, 2);

let seq = 0;
const apply = (ester: Ester, timeH: number, extras: Partial<Record<ExtraKey, number>> = {}, id?: string): DoseEvent => {
    seq += 1;
    return { id: id ?? 'apply-' + seq, route: Route.patchApply, ester, doseMG: 0, timeH, extras };
};
const removal = (ester: Ester, timeH: number, patchApplicationId?: string, id?: string): DoseEvent => {
    seq += 1;
    return {
        id: id ?? 'remove-' + seq,
        route: Route.patchRemove,
        ester,
        doseMG: 0,
        timeH,
        extras: {},
        ...(patchApplicationId === undefined ? {} : { patchApplicationId }),
    };
};
const activeWith = (events: DoseEvent[]): CompleteBackupActive => ({
    events,
    labResults: [],
    doseTemplates: [],
    quickDoses: [],
    supplies: [],
    plan: [],
    weight: 70,
    pkParams: null,
    calibrationMethod: 'mipd',
    calibrationHistoryMode: 'retrospective',
});
const storageWith = (events: DoseEvent[]): MemoryStorage => {
    const storage = new MemoryStorage();
    storage.setItem(modeKeyFor(OWNER, MODE, 'events'), JSON.stringify(events));
    return storage;
};

describe('patchRemovalPairs pairs a removal with the patch it closed', () => {
    it('pairs an unlinked removal with the oldest same-hormone patch still on', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const r = removal(Ester.E2, T0 + 72, undefined, 'r1');
        const events = [a1, a2, r];
        expect(patchRemovalPairs(events).get(r)).toBe(a1);
        expect(patchRemovalTimes(events).has(a2)).toBe(false);
    });

    it('keeps the legacy one-hour minimum for an unlinked manual removal', () => {
        const a1 = apply(Ester.E2, T0 + 10, RATE, 'a1');
        const early = removal(Ester.E2, T0 + 10.5, undefined, 'early');
        const atOneHour = removal(Ester.E2, T0 + 11, undefined, 'at1');
        const events = [a1, early, atOneHour];
        const pairs = patchRemovalPairs(events);
        expect(pairs.has(early)).toBe(false);
        expect(pairs.get(atOneHour)).toBe(a1);
    });

    it('still closes the newest patch long after its plan ended, inside the overwear window', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const late = removal(Ester.E2, T0 + 200, undefined, 'late');
        expect(patchRemovalPairs([a1, late]).get(late)).toBe(a1);
    });

    it('ignores a removal for a patch that expired past the overwear window', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const stale = removal(Ester.E2, T0 + 400, undefined, 'stale');
        expect(patchRemovalPairs([a1, stale]).has(stale)).toBe(false);
    });

    it('matches the same hormone only', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const tApply = apply(Ester.T, T0, RATE, 't1');
        const e2Removal = removal(Ester.E2, T0 + 72, undefined, 'r-e2');
        const tRemoval = removal(Ester.T, T0 + 72, undefined, 'r-t');
        const pairs = patchRemovalPairs([a1, tApply, e2Removal, tRemoval]);
        expect(pairs.get(e2Removal)).toBe(a1);
        expect(pairs.get(tRemoval)).toBe(tApply);
    });

    it('lets a removal without a hormone close a patch after the hormone-named ones', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0, RATE, 'a2');
        const e2Removal = removal(Ester.E2, T0 + 72, undefined, 'r-e2');
        const agnostic = removal(Ester.CPA, T0 + 72, undefined, 'r-any');
        const pairs = patchRemovalPairs([a1, a2, e2Removal, agnostic]);
        expect(pairs.get(e2Removal)).toBe(a1);
        expect(pairs.get(agnostic)).toBe(a2);
    });

    it('honors an explicit link across the one-hour minimum', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const r = removal(Ester.E2, T0 + 0.5, 'a1', 'r1');
        const events = [a1, r];
        expect(patchRemovalPairs(events).get(r)).toBe(a1);
        expect(resolvePatchWearH(a1, events)).toBe(0.5);
    });

    it('honors an explicit link even past the overwear window', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const r = removal(Ester.E2, T0 + 400, 'a1', 'r1');
        expect(patchRemovalPairs([a1, r]).get(r)).toBe(a1);
    });

    it('drops an explicit link to a missing, foreign-hormone, future, or already-closed target', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const tApply = apply(Ester.T, T0, RATE, 't1');
        const missing = removal(Ester.E2, T0 + 72, 'gone', 'r-missing');
        const foreign = removal(Ester.E2, T0 + 72, 't1', 'r-foreign');
        const future = removal(Ester.E2, T0 - 1, 'a1', 'r-before-apply');
        const retarget = removal(Ester.E2, T0 + 48, 'a1', 'r-retarget');
        const events = [a1, a2, tApply, retarget, missing, foreign, future];
        const pairs = patchRemovalPairs(events);
        expect(pairs.get(retarget)).toBe(a1);
        // A dead link never redirects the removal onto another patch.
        expect(pairs.has(missing)).toBe(false);
        expect(pairs.has(foreign)).toBe(false);
        expect(pairs.has(future)).toBe(false);
        expect(patchRemovalTimes(events).has(a2)).toBe(false);
    });

    it('never resolves a link to a duplicated application id from a legacy import', () => {
        const dup1 = apply(Ester.E2, T0, RATE, 'dup');
        const dup2 = apply(Ester.E2, T0 + 24, RATE, 'dup');
        const r = removal(Ester.E2, T0 + 72, 'dup', 'r1');
        expect(patchRemovalPairs([dup1, dup2, r]).has(r)).toBe(false);
    });

    it('keeps the explicit target when a later manual removal arrives', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const r = removal(Ester.E2, T0 + 72, 'a1', 'r1');
        const laterManual = removal(Ester.E2, T0 + 96, undefined, 'later');
        const events = [a1, r, laterManual];
        const pairs = patchRemovalPairs(events);
        expect(pairs.get(r)).toBe(a1);
        expect(pairs.has(laterManual)).toBe(false);
        expect(resolvePatchWearH(a1, events)).toBe(72);
    });

    it('keeps the legacy target of an earlier manual removal; the later dead link is dropped', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const manual = removal(Ester.E2, T0 + 10, undefined, 'manual');
        const r = removal(Ester.E2, T0 + 72, 'a1', 'r1');
        const events = [a1, manual, r];
        const pairs = patchRemovalPairs(events);
        expect(pairs.get(manual)).toBe(a1);
        expect(pairs.has(r)).toBe(false);
    });

    it('agrees with patchRemovalTimes on a mixed history', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const a2 = apply(Ester.E2, T0 + 48, RATE, 'a2');
        const tRemoval = removal(Ester.T, T0 + 50, undefined, 'r-t');
        const r1 = removal(Ester.E2, T0 + 72, undefined, 'r1');
        const r2 = removal(Ester.E2, T0 + 96, 'a1', 'r2');
        const events = [a1, a2, tRemoval, r1, r2];
        const pairs = patchRemovalPairs(events);
        const times = patchRemovalTimes(events);
        expect(pairs.size).toBe(times.size);
        for (const [removed, closed] of pairs) expect(times.get(closed)).toBe(removed.timeH);
        expect(pairs.has(r2)).toBe(false);
    });
});

describe('patchEntriesWithReplacements generates the records for an opted-in save', () => {
    it('closes a blank-wear patch worn three days with a generated zero-dose removal', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            id: 'rm-new-1',
            route: Route.patchRemove,
            timeH: T0 + 72,
            doseMG: 0,
            ester: Ester.E2,
            extras: {},
            patchApplicationId: 'a1',
        });
        expect(out[1]).toEqual(next);
        const merged = [a1, ...out];
        expect(resolvePatchWearH(a1, merged)).toBe(72);
    });

    it('keeps the planned wear for an on-time rotation', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const next = apply(Ester.E2, T0 + 84, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(patchRemovalTimes([a1, ...out]).get(a1)).toBe(T0 + 84);
        expect(resolvePatchWearH(a1, [a1, ...out])).toBe(84);
    });

    it('closes an early rotation at the replacement time', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const next = apply(Ester.E2, T0 + 30, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(resolvePatchWearH(a1, [a1, ...out])).toBe(30);
    });

    it('works for a sub-hour replacement at a distinct timestamp', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const next = apply(Ester.E2, T0 + 0.5, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ patchApplicationId: 'a1' });
        expect(resolvePatchWearH(a1, [a1, ...out])).toBe(0.5);
    });

    it('closes a late rotation past the logging grace inside the overwear window', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const next = apply(Ester.E2, T0 + 200, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(out).toHaveLength(2);
        expect(resolvePatchWearH(a1, [a1, ...out])).toBe(200);
    });

    it('leaves the application alone when the prior patch expired long ago', () => {
        const a1 = apply(Ester.E2, T0, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'a1');
        const next = apply(Ester.E2, T0 + 400, RATE, 'new-1');
        expect(patchEntriesWithReplacements([a1], [next], ['rm-new-1'])).toEqual([next]);
    });

    it('never closes another hormone through a replacement', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const tPatch = apply(Ester.T, T0 + 72, RATE, 't-new');
        expect(patchEntriesWithReplacements([a1], [tPatch], ['rm-t-new'])).toEqual([tPatch]);
    });

    it('closes the oldest eligible patch when several overlap and preserves the rest', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1, a2], [next], ['rm-new-1']);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ patchApplicationId: 'a1' });
        const merged = [a1, a2, ...out];
        expect(patchRemovalTimes(merged).has(a2)).toBe(false);
    });

    it('keeps a separate patch on when the oldest candidate has an ambiguous legacy ID', () => {
        const older = apply(Ester.E2, T0, RATE, 'duplicate');
        const other = apply(Ester.E2, T0 + 24, RATE, 'unique');
        const duplicate = apply(Ester.E2, T0 + 48, RATE, 'duplicate');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new');
        expect(patchEntriesWithReplacements([older, other, duplicate], [next], ['remove'])).toEqual([next]);
    });

    it('supplements nothing when a manual removal already exists at the exact replacement time', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const manual = removal(Ester.E2, T0 + 72, undefined, 'manual');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1, manual], [next], ['rm-new-1']);
        expect(out).toEqual([next]);
        const merged = [a1, manual, next];
        expect(patchRemovalPairs(merged).get(manual)).toBe(a1);
        expect(patchRemovalTimes(merged).has(next)).toBe(false);
    });

    it('keeps the overlapping patch open when the same-time manual removal covers the replacement', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const manual = removal(Ester.E2, T0 + 72, undefined, 'manual');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1, a2, manual], [next], ['rm-new-1']);
        expect(out).toEqual([next]);
        const merged = [a1, a2, manual, next];
        const pairs = patchRemovalPairs(merged);
        expect(pairs.get(manual)).toBe(a1);
        expect(patchRemovalTimes(merged).has(a2)).toBe(false);
    });

    it('preserves an explicit same-time removal aimed at another overlapping patch', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const manual = removal(Ester.E2, T0 + 72, 'a2', 'manual');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1, a2, manual], [next], ['rm-new-1']);
        expect(out).toEqual([next]);
        const merged = [a1, a2, manual, next];
        const pairs = patchRemovalPairs(merged);
        expect(pairs.get(manual)).toBe(a2);
        expect(patchRemovalTimes(merged).has(a1)).toBe(false);
    });

    it('uses one manual removal for one replacement and records the other replacement at the same time', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const manual = removal(Ester.E2, T0 + 72, undefined, 'manual');
        const first = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const second = apply(Ester.E2, T0 + 72, RATE, 'new-2');
        const out = patchEntriesWithReplacements([a1, a2, manual], [first, second], ['rm-new-1', 'rm-new-2']);
        expect(out).toEqual([first, expect.objectContaining({ patchApplicationId: a2.id }), second]);
        expect(patchRemovalPairs([a1, a2, manual, ...out]).get(manual)).toBe(a1);
    });

    it('replaces two older patches at the same minute in one save or two separate saves', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const a2 = apply(Ester.E2, T0 + 24, RATE, 'a2');
        const first = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const second = apply(Ester.E2, T0 + 72, RATE, 'new-2');
        const out = patchEntriesWithReplacements([a1, a2], [first, second], ['rm-new-1', 'rm-new-2']);
        const one = patchEntriesWithReplacements([a1, a2], [first], ['rm-new-1']);
        const two = patchEntriesWithReplacements([a1, a2, ...one], [second], ['rm-new-2']);
        expect(out).toEqual([
            expect.objectContaining({ patchApplicationId: a1.id }),
            first,
            expect.objectContaining({ patchApplicationId: a2.id }),
            second,
        ]);
        expect([...one, ...two]).toEqual(out);
    });

    it('can replace an already saved patch at the same time without ending another new patch in the same batch', () => {
        const prior = apply(Ester.E2, T0, RATE, 'old');
        const first = apply(Ester.E2, T0, RATE, 'first');
        const second = apply(Ester.E2, T0, RATE, 'second');
        const added = patchEntriesWithReplacements([prior], [first, second], ['off1', 'off2']);
        expect(added).toEqual([expect.objectContaining({ patchApplicationId: prior.id }), first, second]);
        expect(resolvePatchWearH(prior, [prior, ...added])).toBe(0);
        expect(patchRemovalTimes([prior, ...added]).has(first)).toBe(false);
        expect(patchEntriesWithReplacements([], [first, second], ['off1', 'off2'])).toEqual([first, second]);
    });

    it('closes nothing when no prior patch is eligible', () => {
        const next = apply(Ester.E2, T0, RATE, 'new-1');
        expect(patchEntriesWithReplacements([], [next], ['rm-new-1'])).toEqual([next]);
    });

    it('emits records chronologically with each removal immediately before its application', () => {
        const a1 = apply(Ester.E2, T0 - 72, RATE, 'a1');
        const late = apply(Ester.E2, T0 + 144, RATE, 'late');
        const early = apply(Ester.E2, T0, RATE, 'early');
        const out = patchEntriesWithReplacements([a1], [late, early], ['rm-late', 'rm-early']);
        for (let i = 1; i < out.length; i++) expect(out[i].timeH).toBeGreaterThanOrEqual(out[i - 1].timeH);
        expect(out[0]).toMatchObject({ id: 'rm-early', route: Route.patchRemove, patchApplicationId: 'a1' });
        expect(out[1]).toEqual(early);
        expect(out[2]).toMatchObject({ id: 'rm-late', patchApplicationId: 'early' });
        expect(out[3]).toEqual(late);
    });

    it('does not mutate its inputs and is deterministic across repeated calls', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const existingSnapshot = JSON.stringify([a1]);
        const applicationsSnapshot = JSON.stringify([next]);
        const first = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        const second = patchEntriesWithReplacements([a1], [next], ['rm-new-1']);
        expect(JSON.stringify([a1])).toBe(existingSnapshot);
        expect(JSON.stringify([next])).toBe(applicationsSnapshot);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('never attaches a link to the kept application itself', () => {
        const next = apply(Ester.E2, T0, RATE, 'new-1');
        const out = patchEntriesWithReplacements([], [next], ['rm-new-1']);
        expect(out).toHaveLength(1);
        expect(out[0].patchApplicationId).toBeUndefined();
    });

    it('keeps the generated target when a later manual removal exists; legacy inference picks the new patch', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const laterManual = removal(Ester.E2, T0 + 96, undefined, 'later');
        const next = apply(Ester.E2, T0 + 72, RATE, 'new-1');
        const out = patchEntriesWithReplacements([a1, laterManual], [next], ['rm-new-1']);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ patchApplicationId: 'a1' });
        const merged = [a1, laterManual, ...out];
        const pairs = patchRemovalPairs(merged);
        const generated = merged.find(event => event.id === 'rm-new-1')!;
        expect(pairs.get(generated)).toBe(a1);
        // The stale manual removal keeps its legacy inference: the newest prior
        // patch is now the replacement itself, so it closes 24 h after going on.
        expect(pairs.get(laterManual)).toBe(next);
        expect(resolvePatchWearH(a1, merged)).toBe(72);
        expect(resolvePatchWearH(next, merged)).toBe(24);
    });

    it('chains all 365 applications in a full batch against earlier history', () => {
        const history: DoseEvent[] = [];
        for (let i = 0; i < 400; i++) {
            history.push(apply(Ester.E2, T0 + i * 72, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'hist-' + i));
        }
        const applications: DoseEvent[] = [];
        for (let i = 0; i < 365; i++) {
            applications.push(apply(Ester.E2, T0 + (400 + i) * 72, { ...RATE, [ExtraKey.patchWearH]: 84 }, 'app-' + i));
        }
        const removalIds = applications.map(application => 'rm-' + application.id);
        const out = patchEntriesWithReplacements(history, applications, removalIds);
        expect(out).toHaveLength(730);
        for (let i = 1; i < out.length; i++) expect(out[i].timeH).toBeGreaterThanOrEqual(out[i - 1].timeH);
        const byId = new Map<string, DoseEvent>();
        for (const event of out) byId.set(event.id, event);
        expect(byId.get('rm-app-0')!.patchApplicationId).toBe('hist-399');
        for (let i = 1; i < applications.length; i++) {
            expect(byId.get('rm-app-' + i)!.patchApplicationId).toBe('app-' + (i - 1));
        }
        const merged = [...history, ...out];
        expect(patchRemovalTimes(merged).get(history[399])).toBe(applications[0].timeH);
        expect(patchRemovalTimes(merged).get(applications[0])).toBe(applications[1].timeH);
        expect(resolvePatchWearH(applications[364], merged)).toBe(84);
    });
});

describe('patchApplicationId survives storage and backups', () => {
    it('keeps a valid link and never turns a malformed linked removal into an inferred removal', () => {
        const sanitized = sanitizeImportedEvents([
            {
                id: 'r1',
                route: Route.patchRemove,
                timeH: T0 + 72,
                doseMG: 0,
                ester: Ester.E2,
                extras: {},
                patchApplicationId: 'a1',
            },
            {
                id: 'r2',
                route: Route.patchRemove,
                timeH: T0 + 96,
                doseMG: 0,
                ester: Ester.E2,
                extras: {},
                patchApplicationId: 5,
            },
            {
                id: 'a2',
                route: Route.patchApply,
                timeH: T0 + 120,
                doseMG: 0,
                ester: Ester.E2,
                extras: {},
                patchApplicationId: 'a1',
            },
        ]);
        expect(sanitized[0].patchApplicationId).toBe('a1');
        expect(sanitized.map(event => event.id)).toEqual(['r1', 'a2']);
        expect(sanitized[1].patchApplicationId).toBeUndefined();
    });

    it('round-trips an explicit link through a complete backup', () => {
        const a1 = apply(Ester.E2, T0, RATE, 'a1');
        const r1 = removal(Ester.E2, T0 + 30, 'a1', 'r1');
        const bundle = buildCompleteBackupBundleReportFromStorage(
            storageWith([a1, r1]),
            OWNER,
            MODE,
            activeWith([a1, r1]),
            CREATED_AT,
            NOW,
        ).bundle;
        const target = new MemoryStorage();
        const context: CompleteBackupContext = {
            storage: target,
            owner: OWNER,
            mode: MODE,
            active: activeWith([]),
            now: NOW,
        };
        expect(inspectCompleteBackupBundle(bundle, context).ok).toBe(true);
        const result = mergeCompleteBackupBundleToStorage(bundle, context);
        expect(result.blocked).toEqual([]);
        const stored = JSON.parse(target.getItem(modeKeyFor(OWNER, MODE, 'events'))!) as DoseEvent[];
        expect(stored.find(event => event.id === 'r1')!.patchApplicationId).toBe('a1');
        expect(stored.find(event => event.id === 'a1')!.patchApplicationId).toBeUndefined();
    });

    it('rejects a link attached to a non-removal record in a bundle', () => {
        const bad = { ...apply(Ester.E2, T0, RATE, 'a1'), patchApplicationId: 'a1' };
        const report = buildCompleteBackupBundleReportFromStorage(
            storageWith([bad]),
            OWNER,
            MODE,
            activeWith([bad]),
            CREATED_AT,
            NOW,
        );
        // Export validates too: the invalid record is dropped and reported.
        expect(report.invalidRecords).toBe(1);
        expect(report.issues.join(' ')).toContain('patchApplicationId');
        const bundle = report.bundle;
        // Import validates what a hand-edited or third-party file carries.
        const hostile = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
        (hostile.modes[MODE].events ??= []).push(JSON.parse(JSON.stringify(bad)));
        const context: CompleteBackupContext = {
            storage: new MemoryStorage(),
            owner: OWNER,
            mode: MODE,
            active: activeWith([]),
            now: NOW,
        };
        expect(inspectCompleteBackupBundle(hostile, context).blocked).toContain('transfem.events');
    });
});
