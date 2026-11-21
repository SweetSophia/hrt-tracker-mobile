import { expect, it } from 'vitest';
import { RecordController } from '../../src/application/recordController';
import { WebRecordStore } from '../../src/platform/web/recordStore';
import { MemoryStorage } from '../memoryStorage';
import { planCompleteBackup, planRecordOperation } from '../../src/records';
import { exportRecordState, planLegacyImport, prepareLegacyImport } from '../../src/records/commands';
import {
    prepareScreenRecords,
    readScreenRecords,
    screenFixtures,
    SCREEN_NOW,
} from '../../mobile/storageQualification/screenMigration';

async function setup() {
    const store = new WebRecordStore(new MemoryStorage(), 'offline');
    const controller = new RecordController(store);
    await controller.activate({ backend: 'offline', owner: 'local', mode: 'transfem' });
    return { store, controller };
}

it('prepares both modes and distinguishes merge from complete replacement using real planners', async () => {
    const { controller, store } = await setup();
    const { incoming } = screenFixtures();
    await prepareScreenRecords(controller);
    const before = await readScreenRecords(controller, store);
    expect(before.bundle.weight).toBe(77);
    for (const mode of ['transfem', 'transmasc'] as const) {
        expect(before.bundle.modes[mode]?.events?.map(e => e.id)).toEqual([`synthetic-screen-local-${mode}`]);
        for (const category of ['labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan'] as const)
            expect(before.bundle.modes[mode]?.[category]).toHaveLength(0);
    }
    await controller.dispatch(context => planCompleteBackup(context, incoming, 'merge', SCREEN_NOW));
    const merged = await readScreenRecords(controller, store);
    const confirmed = controller.getState();
    if (confirmed.status !== 'ready') throw new Error('Expected ready controller');
    const legacy = exportRecordState(confirmed);
    expect(merged.bundle.weight).toBe(72);
    for (const mode of ['transfem', 'transmasc'] as const) {
        expect(merged.bundle.modes[mode]?.events).toHaveLength(2);
        for (const category of ['labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan', 'deletions'] as const)
            expect(merged.bundle.modes[mode]?.[category]).toEqual(incoming.modes[mode]?.[category]);
    }
    await controller.dispatch(context => planCompleteBackup(context, incoming, 'replace', SCREEN_NOW));
    const replaced = await readScreenRecords(controller, store);
    expect(replaced.bundle.weight).toBe(72);
    expect(replaced.bundle.weightUpdatedAt).toBe(SCREEN_NOW);
    for (const mode of ['transfem', 'transmasc'] as const) {
        expect(replaced.bundle.modes[mode]?.events).toEqual(incoming.modes[mode]?.events);
        expect(replaced.bundle.modes[mode]?.deletions?.events[`synthetic-screen-local-${mode}`]).toBe(SCREEN_NOW);
        expect(replaced.bundle.modes[mode]?.labResults).toEqual(incoming.modes[mode]?.labResults);
    }
    await controller.dispatch(context =>
        planLegacyImport(
            context,
            prepareLegacyImport(legacy, SCREEN_NOW, () => 'unused-synthetic-id'),
            'replace',
            SCREEN_NOW,
        ),
    );
    const restored = await readScreenRecords(controller, store);
    for (const mode of ['transfem', 'transmasc'] as const)
        expect(restored.bundle.modes[mode]?.events).toEqual(merged.bundle.modes[mode]?.events);
});

it('reads durable snapshots rather than a cached controller and never writes during inspection', async () => {
    const { controller, store } = await setup();
    await prepareScreenRecords(controller);
    const other = new RecordController(store);
    await other.activate({ backend: 'offline', owner: 'local', mode: 'transfem' });
    await other.dispatch(context => planRecordOperation(context, storage => storage.setItem('hrt-weight', '83')));
    const fresh = await readScreenRecords(controller, store);
    expect(fresh.bundle.weight).toBe(83);
    expect(await readScreenRecords(controller, store)).toEqual(fresh);
    expect(controller.getState()).not.toEqual(other.getState());
});

it('refuses setup outside the dedicated offline local scope', async () => {
    const { controller } = await setup();
    await controller.activate({ backend: 'offline', owner: 'other-owner', mode: 'transfem' });
    await expect(prepareScreenRecords(controller)).rejects.toThrow('Offline local qualification scope required');
});
