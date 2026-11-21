import { isPlausibleBirthYear, type DoseEvent, type LabResult } from '../domain/engine';
import { activeFromSnapshot } from './index';
import { planRecordOperation, type RecordContext } from './snapshot';
import {
    buildExportPayloadFromStorage,
    LEGACY_AGE_BETA_KEY,
    modeKeyFor,
    nsFor,
    readTombstonesFromStorage,
    writeTombstonesToStorage,
    type DoseTemplate,
    type QuickDose,
    type StorageLike,
} from '../utils/backupState';
import { mergeImportedDataToStorage, processImportedDataToStorage } from '../utils/backupImport';
import { normalizeSupply, type Supply } from '../utils/regimen';
import type { PlanItem } from '../utils/plan';
import type { RecordKind } from '../utils/syncMerge';

const suffixes = {
    events: 'events',
    labResults: 'lab-results',
    doseTemplates: 'dose-templates',
    quickDoses: 'quick-doses',
    supplies: 'supplies',
    plan: 'plan',
} as const;
type ListKind = keyof typeof suffixes;
type Item = DoseEvent | LabResult | DoseTemplate | QuickDose | Supply | PlanItem;
export type RecordEdit =
    | { kind: ListKind; action: 'add' | 'update' | 'upsert'; records: readonly Item[] }
    | { kind: ListKind; action: 'delete'; ids: readonly string[] }
    | { kind: ListKind; action: 'clear' }
    | {
          kind: 'scalar';
          key: 'weight' | 'birth-year' | 'pk-params' | 'cal-method' | 'cal-history-mode' | 'age-beta';
          value: unknown;
      };

export function readRecordState(context: RecordContext) {
    return planRecordOperation(context, storage => {
        const active = activeFromSnapshot(storage, context);
        const year = Number(storage.getItem(nsFor(context.scope.owner, 'birth-year')));
        return {
            ...active,
            supplies: active.supplies.map(normalizeSupply).filter((s): s is Supply => s !== null),
            birthYear: isPlausibleBirthYear(year) ? year : null,
            ageBeta: storage.getItem(nsFor(context.scope.owner, 'age-beta')) === 'true',
        };
    }).result;
}
function scalar(storage: StorageLike, owner: string, key: string, value: unknown, now: number) {
    if (value === null) storage.removeItem(nsFor(owner, key));
    else storage.setItem(nsFor(owner, key), key === 'pk-params' ? JSON.stringify(value) : String(value));
    const stamp = ['cal-method', 'cal-history-mode', 'age-beta'].includes(key) ? 'model-settings-at' : `${key}-at`;
    storage.setItem(nsFor(owner, stamp), String(now));
}
export function planEdit(context: RecordContext, edit: RecordEdit, now: number) {
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid operation clock');
    return planRecordOperation(context, storage => {
        const { owner, mode } = context.scope;
        if (edit.kind === 'scalar') return scalar(storage, owner, edit.key, edit.value, now);
        const active = readRecordState(context);
        const previous: readonly Item[] = active[edit.kind];
        const syncKind = (['events', 'labResults', 'doseTemplates'] as string[]).includes(edit.kind);
        const tombstones = readTombstonesFromStorage(storage, owner, mode);
        const kind = edit.kind as RecordKind;
        let next: readonly Item[];
        if (edit.action === 'delete' || edit.action === 'clear') {
            const ids = new Set(edit.action === 'clear' ? previous.map(record => record.id) : edit.ids);
            next = previous.filter(record => !ids.has(record.id));
            if (syncKind) for (const id of ids) if (id) tombstones[kind][id] = now;
        } else {
            const records = edit.records.map(record => (syncKind ? { ...record, updatedAt: now } : record));
            if (edit.action === 'add') next = [...previous, ...records];
            else {
                const replacements = new Map(records.map(record => [record.id, record]));
                next = previous.map(record => replacements.get(record.id) ?? record);
                if (edit.action === 'upsert') {
                    const existing = new Set(previous.map(record => record.id));
                    next = [...next, ...records.filter(record => !existing.has(record.id))];
                }
            }
            if (syncKind && edit.action !== 'update') for (const record of records) delete tombstones[kind][record.id];
        }
        storage.setItem(modeKeyFor(owner, mode, suffixes[edit.kind]), JSON.stringify(next));
        if (syncKind) writeTombstonesToStorage(storage, owner, mode, tombstones, now);
        if (edit.kind === 'plan') {
            storage.setItem(modeKeyFor(owner, mode, 'plan-at'), String(now));
            if (mode === 'transfem') storage.removeItem(nsFor(owner, 'cpa-plan'));
        }
    });
}

/** Copy untrusted input and allocate nondeterministic defaults once, before planning. */
export function prepareLegacyImport(raw: unknown, now: number, newId: () => string): unknown {
    const input = structuredClone(raw);
    const records = (items: unknown, templates = false) =>
        Array.isArray(items)
            ? items.map(item => {
                  if (!item || typeof item !== 'object') return item;
                  return {
                      ...item,
                      id: typeof item.id === 'string' ? item.id : newId(),
                      ...(templates ? { createdAt: Number.isFinite(item.createdAt) ? item.createdAt : now } : {}),
                  };
              })
            : items;
    if (Array.isArray(input)) return records(input);
    if (!input || typeof input !== 'object') return input;
    const block = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const obj = value as Record<string, unknown>;
        for (const key of ['events', 'labResults', 'doseTemplates'])
            if (Object.hasOwn(obj, key)) obj[key] = records(obj[key], key === 'doseTemplates');
    };
    block(input);
    const modes = (input as { modes?: Record<string, unknown> }).modes;
    if (modes && typeof modes === 'object') for (const mode of ['transfem', 'transmasc']) block(modes[mode]);
    return input;
}
export function planLegacyImport(
    context: RecordContext,
    prepared: unknown,
    strategy: 'merge' | 'replace',
    now: number,
) {
    return planRecordOperation(context, storage => {
        const active = readRecordState(context);
        const { owner, mode } = context.scope;
        const target = { storage, owner, mode, active };
        const result =
            strategy === 'merge'
                ? mergeImportedDataToStorage(prepared, target, { now })
                : processImportedDataToStorage(prepared, target, { now });
        for (const kind of ['events', 'labResults', 'doseTemplates'] as const) {
            if (result[kind] !== undefined)
                storage.setItem(
                    modeKeyFor(owner, mode, suffixes[kind]),
                    JSON.stringify(strategy === 'merge' ? [...active[kind], ...result[kind]] : result[kind]),
                );
        }
        if (result.weight !== undefined) scalar(storage, owner, 'weight', result.weight, now);
        if (result.birthYear !== undefined) scalar(storage, owner, 'birth-year', result.birthYear, now);
        if ('pkParams' in result && result.pkParams !== undefined)
            scalar(storage, owner, 'pk-params', result.pkParams, now);
        return result;
    });
}

/** Bind consent to both the scope and exact confirmed contents, including preferences. */
export const reviewBinding = (context: RecordContext): string => JSON.stringify([context.scope, context.snapshots]);
export function assertReview(context: RecordContext, binding: string): void {
    if (reviewBinding(context) !== binding) throw new Error('Records changed; review the import again.');
}

/** Bootstrap has already adopted the legacy global flag into the owner snapshot. */
export function exportRecordState(context: RecordContext) {
    return planRecordOperation(context, storage =>
        buildExportPayloadFromStorage(
            { ...storage, getItem: key => (key === LEGACY_AGE_BETA_KEY ? null : storage.getItem(key)) },
            context.scope.owner,
            context.scope.mode,
            readRecordState(context),
        ),
    ).result;
}
