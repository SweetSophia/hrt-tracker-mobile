import { describe, expect, it } from 'vitest';
import { Ester, ExtraKey, Route, type DoseEvent } from '../src/domain/types';
import {
    buildCompleteBackupBundleReportFromStorage,
    inspectCompleteBackupBundle,
    mergeCompleteBackupBundleToStorage,
    type CompleteBackupActive,
} from '../src/utils/backupBundle';
import { mergeImportedDataToStorage, processImportedDataToStorage } from '../src/utils/backupImport';
import { modeKeyFor, readTombstonesFromStorage } from '../src/utils/backupState';
import { emptyTombstones } from '../src/utils/syncMerge';
import { MemoryStorage } from './memoryStorage';

const owner = 'synthetic';
const mode = 'transfem' as const;
const now = Date.UTC(2030, 0, 2);
const eventsKey = modeKeyFor(owner, mode, 'events');
const application: DoseEvent = {
    id: 'patch',
    route: Route.patchApply,
    ester: Ester.E2,
    doseMG: 0.3,
    timeH: 480_000,
    extras: { [ExtraKey.releaseRateUGPerDay]: 100, [ExtraKey.patchWearH]: 72 },
    updatedAt: 1000,
};
const changed = { ...application, timeH: application.timeH + 48, updatedAt: 2000 };
const removal: DoseEvent = {
    id: 'removal',
    route: Route.patchRemove,
    ester: Ester.E2,
    doseMG: 0,
    timeH: application.timeH + 72,
    extras: {},
    patchApplicationId: application.id,
    updatedAt: 1000,
};
const unrelated = { ...application, id: 'another-patch', timeH: application.timeH + 96 };

const active = (events: DoseEvent[]) => ({ events, labResults: [], doseTemplates: [], weight: 70, birthYear: null });
const storedEvents = (storage: MemoryStorage): DoseEvent[] => JSON.parse(storage.getItem(eventsKey) ?? '[]');

describe('patch links in legacy imports', () => {
    it.each([
        { name: 'active mode', current: 'transfem', multiMode: false, replace: false },
        { name: 'inactive mode', current: 'transmasc', multiMode: true, replace: false },
        { name: 'flat cross-mode merge', current: 'transmasc', multiMode: false, replace: false },
        { name: 'flat cross-mode replace', current: 'transmasc', multiMode: false, replace: true },
    ] as const)(
        'skips only the conflicting removal and preserves its tombstone in $name',
        ({ current, multiMode, replace }) => {
            const storage = new MemoryStorage();
            storage.setItem(eventsKey, JSON.stringify([application]));
            storage.setItem(
                modeKeyFor(owner, mode, 'deletions'),
                JSON.stringify({
                    ...emptyTombstones(),
                    events: { [removal.id]: now - 1 },
                }),
            );
            const block = { events: [changed, removal, unrelated] };
            const payload = multiMode ? { modes: { [mode]: block } } : block;
            const context = { storage, owner, mode: current, active: active(current === mode ? [application] : []) };
            if (replace) {
                processImportedDataToStorage(payload, context, { now });
            } else {
                const result = mergeImportedDataToStorage(payload, context, { now });
                expect(result.mergedCount).toBe(1);
                expect(result.events).toEqual(current === mode ? [unrelated] : []);
            }
            expect(storedEvents(storage)).toEqual(current === mode ? [application] : [application, unrelated]);
            expect(readTombstonesFromStorage(storage, owner, mode).events[removal.id]).toBe(now - 1);
        },
    );

    it.each([
        ['an identical application', application],
        [
            'the same application with a different edit stamp and harmless dose rounding',
            {
                ...application,
                updatedAt: 3000,
                doseMG: 0.30000001,
                extras: { [ExtraKey.patchWearH]: 72, [ExtraKey.releaseRateUGPerDay]: 100 },
            },
        ],
    ] as const)('keeps a link to %s', (_, local) => {
        const context = { storage: new MemoryStorage(), owner, mode, active: active([local]) };
        const result = mergeImportedDataToStorage({ events: [application, removal] }, context, { now });
        expect(result.events).toEqual([removal]);
    });

    it.each([
        ['matching', application],
        ['changed', changed],
    ] as const)('restores the %s incoming patch and its removal on active-mode replace', (_, incoming) => {
        const context = { storage: new MemoryStorage(), owner, mode, active: active([application]) };
        expect(processImportedDataToStorage({ events: [incoming, removal] }, context, { now }).events).toEqual([
            incoming,
            removal,
        ]);
    });
});

const bundleActive = (events: DoseEvent[]): CompleteBackupActive => ({
    ...active(events),
    quickDoses: [],
    supplies: [],
    plan: [],
    pkParams: null,
    calibrationMethod: 'mipd',
    calibrationHistoryMode: 'retrospective',
});

function mergeComplete(local: DoseEvent[], incoming: DoseEvent[]) {
    const source = new MemoryStorage();
    const storage = new MemoryStorage();
    storage.setItem(eventsKey, JSON.stringify(local));
    const bundle = buildCompleteBackupBundleReportFromStorage(
        source,
        owner,
        mode,
        bundleActive(incoming),
        new Date(now).toISOString(),
        now,
    ).bundle;
    const context = { storage, owner, mode, active: bundleActive(local), now };
    const preview = inspectCompleteBackupBundle(bundle, context);
    const result = mergeCompleteBackupBundleToStorage(bundle, context);
    return { preview, result, stored: storedEvents(storage) };
}

describe('patch links in complete backup merges', () => {
    it.each([
        { name: 'a newer local target wins', local: [changed], incoming: [application, removal] },
        {
            name: 'a newer incoming target would redirect a local-only removal',
            local: [application, removal],
            incoming: [changed],
        },
        {
            name: 'different targets have equal edit stamps',
            local: [{ ...application, updatedAt: changed.updatedAt }],
            incoming: [changed, removal],
        },
    ])('reports the conflict and preserves the local events when $name', ({ local, incoming }) => {
        const { preview, result, stored } = mergeComplete(local, incoming);
        expect(preview.blocked).toContain('transfem.events');
        expect(result.blocked).toContain('transfem.events');
        expect(stored).toEqual(local);
    });

    it.each([
        { name: 'both targets match', local: [application], target: application },
        { name: 'the incoming pair wins together', local: [application], target: changed },
        {
            name: 'both sides confirm the pair and only the target was edited',
            local: [application, removal],
            target: changed,
        },
    ])('retains the link when $name', ({ local, target }) => {
        const { preview, result, stored } = mergeComplete(local, [target, removal]);
        expect(preview.blocked).toEqual([]);
        expect(preview.conflicts).toEqual([]);
        expect(result.blocked).toEqual([]);
        expect(stored).toEqual([target, removal]);
    });
});
