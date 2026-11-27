import { expect, it } from 'vitest';
import { Ester, Route } from '../../src/domain/engine';
import { planCompleteBackup, planRecordOperation, planSyncedState, readReportRecords } from '../../src/records';
import {
    allowedKeys,
    DEVICE_PREFERENCES_NAMESPACE,
    namespacesFor,
    recordNamespace,
    PREFERENCES_NAMESPACE,
    validateChange,
    validateSnapshot,
} from '../../src/records/scope';
import type { RecordScope } from '../../src/records/scope';
import { emptySyncState, emptyTombstones } from '../../src/utils/syncMerge';
import { COMPLETE_BACKUP_FORMAT } from '../../src/utils/backupBundle';

export const scope: RecordScope = { backend: 'offline', owner: 'local', mode: 'transfem' };
const ns = recordNamespace(scope);
const now = Date.UTC(2030, 0, 2);
const event = (id: string) => ({
    id,
    route: Route.oral,
    ester: Ester.E2,
    timeH: 500_000,
    doseMG: 2,
    extras: {},
    updatedAt: now - 1000,
});
const mode = () => ({
    events: [],
    labResults: [],
    doseTemplates: [],
    quickDoses: [],
    supplies: [],
    plan: [],
    deletions: emptyTombstones(),
});
const bundle = () => ({
    format: COMPLETE_BACKUP_FORMAT,
    formatVersion: 1,
    createdAt: new Date(now).toISOString(),
    mode: 'transfem',
    modes: { transfem: mode(), transmasc: mode() },
    calibration: { method: 'mipd', historyMode: 'retrospective' },
    preferences: { 'app-theme': 'dark', 'hrt-lang': 'zh', 'app-auto-backup': true, 'synthetic-secret': 'excluded' },
});
const context = (entries: Record<string, string> = {}) => ({
    scope,
    snapshots: {
        [ns]: { revision: 7, entries },
        [PREFERENCES_NAMESPACE]: { revision: 3, entries: { 'hrt-lang': 'en' } },
    },
});

it('separates backend/account namespaces but shares both modes of one account', () => {
    expect(recordNamespace({ ...scope, mode: 'transmasc' })).toBe(ns);
    expect(recordNamespace({ ...scope, backend: 'https://other.invalid' })).not.toBe(ns);
    expect(recordNamespace({ ...scope, owner: '123' })).not.toBe(ns);
    expect(recordNamespace({ ...scope, backend: 'a:b', owner: 'c' })).not.toBe(
        recordNamespace({ ...scope, backend: 'a', owner: 'b:c' }),
    );
});

it('reads only the selected mode’s doses and labs for a report', () => {
    const activeDose = event('active-dose');
    const otherDose = { ...event('other-dose'), ester: Ester.T };
    const lab = { id: 'other-lab', timeH: 500_000, concValue: 12, unit: 'nmol/l' };
    const input = context({
        'hrt-events': JSON.stringify([activeDose]),
        'hrt-masc-events': JSON.stringify([otherDose]),
        'hrt-masc-lab-results': JSON.stringify([lab]),
        'hrt-masc-dose-templates': 'unrelated unreadable template',
    });
    const read = (owner: string, mode: RecordScope['mode']) =>
        planRecordOperation(input, storage => readReportRecords(storage, owner, mode)).result;
    expect(read(scope.owner, 'transfem')).toEqual({ events: [activeDose], labResults: [] });
    expect(read(scope.owner, 'transmasc')).toEqual({ events: [otherDose], labResults: [lab] });
    expect(() => read('other-owner', 'transmasc')).toThrow('Record key outside scope');
});

it.each(['token', 'hrt-cloud-key', 'hrt-u123-events', 'hrt-replace-journal-v1', '__proto__', 'app-theme'])(
    'rejects non-record key %s',
    key => {
        expect(() => validateSnapshot(ns, { revision: 0, entries: { [key]: 'synthetic' } })).toThrow();
        expect(() => validateChange({ namespace: ns, expectedRevision: 0, puts: {}, removes: [key] })).toThrow();
    },
);
it('validates revisions, namespace encoding, values and conflicting mutations', () => {
    for (const revision of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => validateSnapshot(ns, { revision, entries: {} })).toThrow();
    }
    expect(() => validateSnapshot('unknown', { revision: 0, entries: {} })).toThrow();
    expect(() => validateSnapshot(ns, { revision: 0, entries: { 'hrt-weight': 70 as unknown as string } })).toThrow();
    expect(() =>
        validateChange({ namespace: ns, expectedRevision: 0, puts: { 'hrt-weight': '70' }, removes: ['hrt-weight'] }),
    ).toThrow();
});

it('keeps device preferences as a standalone namespace outside portable scope', () => {
    expect(DEVICE_PREFERENCES_NAMESPACE).toBe('device-preferences:v1');
    expect(namespacesFor(scope)).toEqual([ns, PREFERENCES_NAMESPACE]);
    expect([...allowedKeys(DEVICE_PREFERENCES_NAMESPACE)].sort()).toEqual(['hrt-mode']);
    expect(() => validateSnapshot(DEVICE_PREFERENCES_NAMESPACE, { revision: 0, entries: {} })).not.toThrow();
    expect(() =>
        validateChange({
            namespace: DEVICE_PREFERENCES_NAMESPACE,
            expectedRevision: 0,
            puts: { 'hrt-mode': 'transfem' },
            removes: [],
        }),
    ).not.toThrow();
    expect(() =>
        validateChange({
            namespace: DEVICE_PREFERENCES_NAMESPACE,
            expectedRevision: 0,
            puts: {},
            removes: ['hrt-mode'],
        }),
    ).not.toThrow();
});

it('rejects device preference writes without the mode key, a mode value, or a portable key', () => {
    const invalid = [{ 'app-theme': 'transfem' }, { 'hrt-mode': 'unknown-mode' }];
    for (const puts of invalid) {
        expect(() => validateSnapshot(DEVICE_PREFERENCES_NAMESPACE, { revision: 1, entries: puts })).toThrow();
        expect(() =>
            validateChange({ namespace: DEVICE_PREFERENCES_NAMESPACE, expectedRevision: 1, puts, removes: [] }),
        ).toThrow();
    }
    expect(() =>
        validateChange({
            namespace: DEVICE_PREFERENCES_NAMESPACE,
            expectedRevision: 1,
            puts: {},
            removes: ['app-theme'],
        }),
    ).toThrow();
    expect(() =>
        validateSnapshot(DEVICE_PREFERENCES_NAMESPACE, { revision: 1, entries: { 'hrt-mode': 'transmasc' } }),
    ).not.toThrow();
});

it('plans complete replace with both modes, tombstones and portable preferences without mutating inputs', () => {
    const input = context({
        'hrt-events': JSON.stringify([event('old')]),
        'hrt-masc-events': JSON.stringify([event('old-t')]),
    });
    const original = structuredClone(input);
    const raw = bundle();
    raw.modes.transfem.events = [event('new')] as never[];
    const planned = planCompleteBackup(input, raw, 'replace', now);
    expect(input).toEqual(original);
    expect(planned.result.preview.preferences.ignored).toContain('app-auto-backup');
    expect(planned.changes.map(change => change.namespace)).toEqual([ns, PREFERENCES_NAMESPACE]);
    const records = planned.changes[0];
    expect(records.expectedRevision).toBe(7);
    expect(JSON.parse(records.puts['hrt-events'])).toEqual([event('new')]);
    expect(records.puts['hrt-masc-events']).toBe('[]');
    expect(JSON.parse(records.puts['hrt-deletions']).events.old).toBe(now);
    expect(planned.changes[1]).toEqual({
        namespace: PREFERENCES_NAMESPACE,
        expectedRevision: 3,
        puts: { 'app-theme': 'dark', 'hrt-lang': 'zh' },
        removes: [],
    });
    expect(JSON.stringify(planned.changes)).not.toContain('journal');
    expect(JSON.stringify(planned.changes)).not.toContain('synthetic-secret');
});

it('preserves equal-stamp conflicts from the upstream merge preview', () => {
    const existing = event('same');
    const raw = bundle();
    raw.modes.transfem.events = [{ ...existing, doseMG: 3 }] as never[];
    const planned = planCompleteBackup(context({ 'hrt-events': JSON.stringify([existing]) }), raw, 'merge', now);
    expect(planned.result.preview.conflicts.length).toBeGreaterThan(0);
    expect(planned.changes[0].puts['hrt-events']).toBeUndefined();
});

it('rejects an invalid replace without any partial plan or input writes', () => {
    const input = context();
    const original = structuredClone(input);
    const raw = bundle();
    delete (raw.modes.transmasc as Partial<ReturnType<typeof mode>>).plan;
    expect(() => planCompleteBackup(input, raw, 'replace', now)).toThrow(/required for replace/);
    expect(input).toEqual(original);
});

it('keeps omitted PK overrides but removes explicit null in complete restore', () => {
    const input = context({ 'hrt-pk-params': JSON.stringify({ e2_kClear: 0.42 }) });
    expect(planCompleteBackup(input, bundle(), 'replace', now).changes[0].removes).not.toContain('hrt-pk-params');
    expect(planCompleteBackup(input, { ...bundle(), pkParams: null }, 'replace', now).changes[0].removes).toContain(
        'hrt-pk-params',
    );
});

it('keeps sync omissions separate from explicit clears and preserves model-settings stamps', () => {
    const input = context({ 'hrt-birth-year': '1980', 'hrt-pk-params': '{}', 'hrt-plan': '[]' });
    const state = emptySyncState();
    const omitted = planSyncedState(input, state, now);
    expect(omitted.changes[0].removes).toEqual([]);
    state.birthYear = null;
    state.birthYearUpdatedAt = now;
    state.pkParams = null;
    state.modelSettings = { calibrationMethod: 'ekf', calibrationHistoryMode: 'forward', ageBeta: true };
    state.modelSettingsUpdatedAt = now;
    const cleared = planSyncedState(input, state, now);
    expect(cleared.changes[0].removes).toEqual(expect.arrayContaining(['hrt-birth-year', 'hrt-pk-params']));
    expect(cleared.changes[0].puts['hrt-model-settings-at']).toBe(String(now));
    expect(cleared.changes[0].puts['hrt-age-beta']).toBe('true');
    expect(cleared.changes[0].puts['hrt-plan']).toBeUndefined();
});

it('requires normalized sync IDs and template dates instead of generating nondeterministic values', () => {
    const state = emptySyncState();
    state.modes.transfem.events = [{ ...event('x'), id: undefined }];
    expect(() => planSyncedState(context(), state, now)).toThrow(/normalized/);
});

it('confines overlay reads/writes and guards unchanged read dependencies', () => {
    const input = context();
    const planned = planRecordOperation(input, storage => {
        expect(storage.getItem('hrt-weight')).toBeNull();
        storage.setItem('hrt-weight', '72');
        return 'synthetic result';
    });
    expect(planned.result).toBe('synthetic result');
    expect(planned.changes[1]).toEqual({
        namespace: PREFERENCES_NAMESPACE,
        expectedRevision: 3,
        puts: {},
        removes: [],
    });
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
        expect(() => planRecordOperation(input, storage => storage[method]('token', 'synthetic'))).toThrow();
    }
    expect(() =>
        planRecordOperation(
            { ...input, snapshots: { ...input.snapshots, other: { revision: 0, entries: {} } } },
            () => null,
        ),
    ).toThrow();
});

it('uses account-specific legacy keys in both modes without crossing the namespace', () => {
    const target: RecordScope = { backend: 'https://synthetic.invalid', owner: '42', mode: 'transmasc' };
    const namespace = recordNamespace(target);
    const input = {
        scope: target,
        snapshots: {
            [namespace]: { revision: 2, entries: {} },
            [PREFERENCES_NAMESPACE]: { revision: 0, entries: {} },
        },
    };
    const state = emptySyncState();
    state.modes.transfem.events = [event('tf')];
    state.modes.transmasc.events = [{ ...event('tm'), ester: Ester.TE, route: Route.injection }];
    const plan = planSyncedState(input, state, now);
    expect(plan.changes[0].namespace).toBe(namespace);
    expect(Object.keys(plan.changes[0].puts).every(key => key.startsWith('hrt-u42-'))).toBe(true);
    expect(JSON.parse(plan.changes[0].puts['hrt-u42-masc-events'])[0].id).toBe('tm');
    expect(plan.result.active.events[0].id).toBe('tm');
    expect(planSyncedState(input, state, now)).toEqual(plan);
});

it.each(['local', '42'])('preserves the legacy CPA schedule when merging for owner %s', owner => {
    const target = { ...scope, owner };
    const namespace = recordNamespace(target);
    const prefix = owner === 'local' ? 'hrt-' : `hrt-u${owner}-`;
    const input = {
        scope: target,
        snapshots: {
            [namespace]: { revision: 1, entries: { [`${prefix}cpa-plan`]: '{"plan":"daily"}' } },
            [PREFERENCES_NAMESPACE]: { revision: 0, entries: {} },
        },
    };
    const original = structuredClone(input);
    const plan = planCompleteBackup(input, bundle(), 'merge', now);
    expect(JSON.parse(plan.changes[0].puts[`${prefix}plan`])).toEqual([
        {
            id: 'cpa',
            route: Route.oral,
            ester: Ester.CPA,
            doseMG: 12.5,
            extras: {},
            everyDays: 1,
            timesPerDay: 1,
        },
    ]);
    expect(input).toEqual(original);
});

it('does not revive a legacy CPA schedule after an explicit modern clear or replace', () => {
    const legacy = { 'hrt-cpa-plan': '{"plan":"alternate"}' };
    const merged = planCompleteBackup(context({ ...legacy, 'hrt-plan': '[]' }), bundle(), 'merge', now);
    expect(merged.changes[0].puts['hrt-plan']).toBeUndefined();
    const replaced = planCompleteBackup(context(legacy), bundle(), 'replace', now);
    expect(replaced.changes[0].puts['hrt-plan']).toBe('[]');
});
