import { expect, it } from 'vitest';
import { Route, Ester } from '../../src/domain/engine';
import { RecordController } from '../../src/application/recordController';
import { WebRecordStore } from '../../src/platform/web/recordStore';
import {
    exportRecordState,
    planEdit,
    planLegacyImport,
    prepareLegacyImport,
    readRecordState,
    reviewBinding,
    assertReview,
} from '../../src/records/commands';
import { planRecordOperation } from '../../src/records';
import { recordNamespace } from '../../src/records/scope';

const scope = { backend: 'web', owner: 'local', mode: 'transfem' } as const;
const now = 1_800_000_000_000;
const event = { id: 'dose', route: Route.oral, ester: Ester.E2, extras: {}, timeH: now / 3600000, doseMG: 2 };
const start = async () => {
    const data = new Map<string, string>();
    const store = new WebRecordStore(
        {
            getItem: k => data.get(k) ?? null,
            setItem: (k, v) => {
                data.set(k, v);
            },
            removeItem: k => {
                data.delete(k);
            },
        },
        'web',
    );
    const controller = new RecordController(store);
    await controller.activate(scope);
    const context = () => {
        const state = controller.getState();
        if (state.status !== 'ready') throw new Error('Not ready');
        return state;
    };
    return { controller, data, context };
};
it('serializes additions, deletion tombstones and explicit resurrection in one batch each', async () => {
    const { controller, data, context } = await start();
    await Promise.all([
        controller.dispatch(c => planEdit(c, { kind: 'events', action: 'add', records: [event] }, now)),
        controller.dispatch(c =>
            planEdit(c, { kind: 'events', action: 'add', records: [{ ...event, id: 'second' }] }, now + 1),
        ),
    ]);
    expect(readRecordState(context()).events.map(e => e.id)).toEqual(['dose', 'second']);
    await controller.dispatch(c => planEdit(c, { kind: 'events', action: 'delete', ids: ['dose'] }, now + 2));
    expect(JSON.parse(data.get('hrt-deletions')!).events.dose).toBe(now + 2);
    await controller.dispatch(c => planEdit(c, { kind: 'events', action: 'add', records: [event] }, now + 3));
    expect(JSON.parse(data.get('hrt-deletions')!).events.dose).toBeUndefined();
    expect(readRecordState(context()).events[1].updatedAt).toBe(now + 3);
});
it('stamps shared edits and explicit null removal without changing the other mode', async () => {
    const { controller, data, context } = await start();
    for (const [key, value] of [
        ['weight', 72],
        ['birth-year', 1990],
        ['age-beta', true],
        ['pk-params', null],
    ] as const)
        await controller.dispatch(c => planEdit(c, { kind: 'scalar', key, value }, now));
    expect(readRecordState(context())).toMatchObject({ weight: 72, birthYear: 1990, ageBeta: true, pkParams: null });
    expect(data.get('hrt-weight-at')).toBe(String(now));
    expect(data.get('hrt-pk-params-at')).toBe(String(now));
    expect(data.get('hrt-model-settings-at')).toBe(String(now));
    expect(data.has('hrt-pk-params')).toBe(false);
    expect(data.has('hrt-masc-events')).toBe(false);
});
it('plans legacy imports deterministically with assigned IDs and dates and commits active arrays', async () => {
    const { controller, context } = await start();
    let id = 0;
    const prepared = prepareLegacyImport(
        { events: [{ ...event, id: undefined }], weight: 73 },
        now,
        () => `id-${++id}`,
    );
    const a = planLegacyImport(context(), prepared, 'replace', now);
    expect(planLegacyImport(context(), prepared, 'replace', now)).toEqual(a);
    expect(id).toBe(1);
    await controller.dispatch(c => planLegacyImport(c, prepared, 'replace', now));
    expect(readRecordState(context()).events).toHaveLength(1);
    expect(readRecordState(context()).events[0].id).toBe('id-1');
    expect(readRecordState(context()).weight).toBe(73);
});
it('rejects a reviewed operation after a queued edit, without applying or replaying it', async () => {
    const { controller, context } = await start();
    const binding = reviewBinding(context());
    const edit = controller.dispatch(c => planEdit(c, { kind: 'scalar', key: 'weight', value: 72 }, now));
    const restore = controller.dispatch(c => {
        assertReview(c, binding);
        return planRecordOperation(c, s => s.setItem('hrt-weight', '50'));
    });
    await edit;
    await expect(restore).rejects.toThrow('review');
    expect(readRecordState(context()).weight).toBe(72);
    expect(context().snapshots[recordNamespace(scope)].revision).toBe(1);
});
it('assigns legacy template timestamps once and preserves both-mode import payloads', () => {
    const raw = {
        modes: { transfem: { doseTemplates: [{ id: 'old' }] }, transmasc: { events: [{ id: 'kept' }, {}] } },
    };
    const prepared = prepareLegacyImport(raw, now, () => 'generated') as typeof raw;
    expect(prepared.modes.transfem.doseTemplates[0]).toEqual({ id: 'old', createdAt: now });
    expect(prepared.modes.transmasc.events).toEqual([{ id: 'kept' }, { id: 'generated' }]);
    expect(raw.modes.transfem.doseTemplates[0]).toEqual({ id: 'old' });
});
it('imports both modes and keeps inactive records while merging into the active mode', async () => {
    const { controller, data, context } = await start();
    const input = prepareLegacyImport(
        {
            modes: {
                transfem: { events: [event] },
                transmasc: { events: [{ ...event, id: 't', route: Route.injection, ester: Ester.TE }] },
            },
        },
        now,
        () => 'generated',
    );
    await controller.dispatch(c => planLegacyImport(c, input, 'replace', now));
    expect(readRecordState(context()).events.map(e => e.id)).toEqual(['dose']);
    expect(JSON.parse(data.get('hrt-masc-events')!).map((e: { id: string }) => e.id)).toEqual(['t']);
    const merge = prepareLegacyImport({ events: [{ ...event, id: 'new' }] }, now, () => 'generated');
    await controller.dispatch(c => planLegacyImport(c, merge, 'merge', now));
    expect(readRecordState(context()).events.map(e => e.id)).toEqual(['dose', 'new']);
    expect(JSON.parse(data.get('hrt-masc-events')!).map((e: { id: string }) => e.id)).toEqual(['t']);
});
it('stamps an explicitly emptied plan and removes only the active legacy CPA key', async () => {
    const { controller, data } = await start();
    await controller.dispatch(c => planEdit(c, { kind: 'plan', action: 'clear' }, now));
    expect(data.get('hrt-plan')).toBe('[]');
    expect(data.get('hrt-plan-at')).toBe(String(now));
    expect(data.has('hrt-masc-plan')).toBe(false);
});

it('exports empty and account snapshots without reading the retired global age flag', async () => {
    const { controller, context } = await start();
    for (const owner of ['local', 'synthetic-account']) {
        await controller.activate({ ...scope, owner });
        expect(exportRecordState(context())).toMatchObject({ events: [], weight: 70 });
    }
});
