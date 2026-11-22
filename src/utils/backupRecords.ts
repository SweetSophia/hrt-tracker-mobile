import { Route } from '../domain/types';
import { cleanDoseMG } from './cleanDose';

export const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A deterministic JSON form for "same timestamp, same content?" checks, so
 * object key order from another device does not look like an edit.
 */
export const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (isObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
};

const indexPatchTargets = (records: readonly unknown[], targets: Set<string>) => {
    const byId = new Map<string, Record<string, unknown> | null>();
    for (const record of records) {
        if (!isObject(record) || typeof record.id !== 'string' || !targets.has(record.id)) continue;
        byId.set(record.id, byId.has(record.id) ? null : record);
    }
    return byId;
};

const sameApplication = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a === b ||
    (a.route === Route.patchApply &&
        b.route === Route.patchApply &&
        a.timeH === b.timeH &&
        a.ester === b.ester &&
        typeof a.doseMG === 'number' &&
        typeof b.doseMG === 'number' &&
        cleanDoseMG(a.doseMG) === cleanDoseMG(b.doseMG) &&
        canonical(a.extras ?? {}) === canonical(b.extras ?? {}));

/** Find source removals whose target ID identifies different records on the two sides. */
export function conflictingPatchRemovals(
    source: readonly unknown[],
    retained: readonly unknown[],
    otherRemovals?: ReadonlyMap<string, Record<string, unknown>>,
): Set<unknown> {
    const removals = source.filter(
        (record): record is Record<string, unknown> & { patchApplicationId: string } =>
            isObject(record) && record.route === Route.patchRemove && typeof record.patchApplicationId === 'string',
    );
    const conflicts = new Set<unknown>();
    if (!removals.length) return conflicts;
    const targets = new Set(removals.map(removal => removal.patchApplicationId));
    const before = indexPatchTargets(source, targets);
    const after = indexPatchTargets(retained, targets);
    for (const removal of removals) {
        const original = before.get(removal.patchApplicationId);
        const kept = after.get(removal.patchApplicationId);
        if (original === undefined || kept === undefined) continue;
        if (original && kept && sameApplication(original, kept)) continue;
        // If the other backup also explicitly paired these two IDs, its winning
        // application is a confirmed edit of the pair, even if its timestamp changed.
        const other = typeof removal.id === 'string' ? otherRemovals?.get(removal.id) : undefined;
        if (
            other?.route === Route.patchRemove &&
            other.ester === removal.ester &&
            other.patchApplicationId === removal.patchApplicationId
        )
            continue;
        conflicts.add(removal);
    }
    return conflicts;
}
