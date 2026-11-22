import { ExtraKey, Route } from '../types';
import type { DoseEvent } from '../types';
import { isEstradiolEster, isTestosteroneEster } from '../constants';

const PATCH_MIN_WEAR_H = 1;
const PATCH_REMOVAL_GRACE_H = 24;
// How far past its planned wear a removal can still end a patch. A twice-weekly
// 0.1 mg/day patch holds about 15.6 days of drug at its labelled rate (Vivelle-Dot
// label: 1.56 mg), and 84 h of planned wear plus this stays inside that.
const PATCH_MAX_OVERWEAR_H = 240;

interface PatchPairs {
    times: Map<DoseEvent, number>;
    applications: Map<DoseEvent, DoseEvent>;
}

const patchRemovalCache = new WeakMap<DoseEvent[], PatchPairs>();

function _patchHormone(e: DoseEvent): 'e2' | 't' | null {
    if (isTestosteroneEster(e.ester)) return 't';
    if (isEstradiolEster(e.ester)) return 'e2';
    return null;
}

export function _plannedWearH(e: DoseEvent): number | null {
    const planned = e.extras?.[ExtraKey.patchWearH];
    return typeof planned === 'number' && Number.isFinite(planned) && planned > 0 ? planned : null;
}

/** Replay both recorded and proposed removals in time order. */
function matchPatches(
    recorded: DoseEvent[],
    requests: { application: DoseEvent; removal: DoseEvent }[] = [],
): PatchPairs {
    const times = new Map<DoseEvent, number>();
    const applications = new Map<DoseEvent, DoseEvent>();
    const proposed = new Set(requests.map(request => request.removal));
    const recordedApplies = recorded.filter(e => e.route === Route.patchApply);
    const applies = recordedApplies
        .concat(requests.map(request => request.application))
        .sort(
            (a, b) =>
                a.timeH - b.timeH ||
                (_plannedWearH(a) ?? Infinity) - (_plannedWearH(b) ?? Infinity) ||
                a.doseMG - b.doseMG ||
                (Number(a.extras?.[ExtraKey.releaseRateUGPerDay]) || 0) -
                    (Number(b.extras?.[ExtraKey.releaseRateUGPerDay]) || 0) ||
                String(a.ester).localeCompare(String(b.ester)) ||
                String(a.id).localeCompare(String(b.id)),
        );
    // Some legacy imports repeat IDs. Untargeted removals still use the original time/content ordering.
    const byId = new Map<string, DoseEvent | null>();
    for (const apply of applies) byId.set(apply.id, byId.has(apply.id) ? null : apply);
    const hormoneRank = (e: DoseEvent) => {
        const h = _patchHormone(e);
        return h === 'e2' ? 0 : h === 't' ? 1 : 2;
    };
    const removals = recorded
        .filter(e => e.route === Route.patchRemove)
        .concat([...proposed])
        .sort(
            (a, b) =>
                a.timeH - b.timeH ||
                Number(proposed.has(a)) - Number(proposed.has(b)) ||
                Number(b.patchApplicationId !== undefined) - Number(a.patchApplicationId !== undefined) ||
                hormoneRank(a) - hormoneRank(b),
        );

    let open: DoseEvent[] = [];
    let next = 0;
    // A removal already logged at the change time can cover one new application.
    // Discount applications already logged with those removals, including an earlier save in the same minute.
    const moment = (timeH: number, hormone: ReturnType<typeof _patchHormone>) => timeH + '/' + hormone;
    const spareRemovals = new Map<string, number>();
    for (const removal of proposed) spareRemovals.set(moment(removal.timeH, _patchHormone(removal)), 0);
    if (proposed.size) {
        for (const apply of recordedApplies) {
            const key = moment(apply.timeH, _patchHormone(apply));
            const balance = spareRemovals.get(key);
            if (balance !== undefined) spareRemovals.set(key, balance - 1);
        }
    }
    for (const removal of removals) {
        const hormone = _patchHormone(removal);
        const replacing = proposed.has(removal);
        if (replacing) {
            if (!hormone) continue;
            const key = moment(removal.timeH, hormone);
            const balance = spareRemovals.get(key) ?? 0;
            if (balance > 0) {
                spareRemovals.set(key, balance - 1);
                continue;
            }
        }
        let matched: DoseEvent | undefined;
        if (removal.patchApplicationId !== undefined) {
            // An edited or deleted target must never redirect an explicit removal to another patch.
            const target = byId.get(removal.patchApplicationId);
            if (
                target &&
                hormone &&
                _patchHormone(target) === hormone &&
                target.timeH < removal.timeH &&
                !times.has(target)
            )
                matched = target;
        } else {
            while (next < applies.length && applies[next].timeH < removal.timeH) open.push(applies[next++]);
            open = open.filter(a => {
                const wear = _plannedWearH(a);
                return !times.has(a) && (wear === null || a.timeH + wear + PATCH_REMOVAL_GRACE_H >= removal.timeH);
            });
            // A person explicitly replacing a patch can take it off within the first hour.
            // Keep the original one-hour inference rule for an unlinked manual removal.
            const fits = (a: DoseEvent) =>
                (hormone === null || _patchHormone(a) === hormone) &&
                (replacing || a.timeH <= removal.timeH - PATCH_MIN_WEAR_H);
            matched = open.find(fits);
            if (!matched) {
                // Outside the normal grace window only the newest prior application can qualify for late removal.
                let last = next - 1;
                while (last >= 0 && !fits(applies[last])) last--;
                if (last < 0) continue;
                let first = last;
                while (first > 0 && applies[first - 1].timeH === applies[last].timeH) first--;
                for (let i = first; i <= last; i++) {
                    const a = applies[i];
                    if (
                        fits(a) &&
                        !times.has(a) &&
                        removal.timeH <= a.timeH + (_plannedWearH(a) ?? 0) + PATCH_MAX_OVERWEAR_H
                    ) {
                        matched = a;
                        break;
                    }
                }
            }
        }
        if (matched) {
            // An ambiguous legacy ID cannot identify this patch. Never substitute a different worn patch.
            if (replacing && (typeof matched.id !== 'string' || !matched.id || byId.get(matched.id) !== matched))
                continue;
            times.set(matched, removal.timeH);
            applications.set(removal, matched);
            if (!replacing && proposed.size) {
                const key = moment(removal.timeH, _patchHormone(matched));
                const balance = spareRemovals.get(key);
                if (balance !== undefined) spareRemovals.set(key, balance + 1);
            }
        }
    }
    return { times, applications };
}

function recordedPairs(events: DoseEvent[]): PatchPairs {
    let cached = patchRemovalCache.get(events);
    if (!cached) {
        cached = matchPatches(events);
        patchRemovalCache.set(events, cached);
    }
    return cached;
}

export function patchRemovalTimes(events: DoseEvent[]): Map<DoseEvent, number> {
    return recordedPairs(events).times;
}

/** Removal record to the application it actually closed, for History. */
export function patchRemovalPairs(events: DoseEvent[]): ReadonlyMap<DoseEvent, DoseEvent> {
    return recordedPairs(events).applications;
}

/** The additional records for an opted-in save, including earlier changes in the same batch. */
export function patchEntriesWithReplacements(
    existing: DoseEvent[],
    applications: readonly DoseEvent[],
    removalIds: readonly string[],
): DoseEvent[] {
    const requests = applications
        .map((application, i) => {
            if (application.route !== Route.patchApply || !removalIds[i])
                throw new Error('Expected a patch application and removal ID');
            const removal: DoseEvent = {
                id: removalIds[i],
                route: Route.patchRemove,
                ester: application.ester,
                timeH: application.timeH,
                doseMG: 0,
                extras: {},
            };
            return { application, removal };
        })
        .sort((a, b) => a.application.timeH - b.application.timeH);
    const pairs = matchPatches(existing, requests).applications;
    const records: DoseEvent[] = [];
    for (const { application, removal } of requests) {
        const target = pairs.get(removal);
        if (target) records.push({ ...removal, patchApplicationId: target.id });
        records.push(application);
    }
    return records;
}

/**
 * How long (hours after application) a patch stays on the skin delivering drug.
 * Resolution order:
 *   1. The patchRemove event paired with this application wins (the user
 *      removed it at a known time, possibly earlier/later than planned).
 *   2. Otherwise the planned wear duration stored on the apply event is used, so
 *      a single "apply" event self-completes.
 *   3. Otherwise the patch is assumed to be worn indefinitely (legacy behaviour).
 */
export function resolvePatchWearH(event: DoseEvent, allEvents: DoseEvent[]): number {
    const removeAt = patchRemovalTimes(allEvents).get(event);
    if (removeAt !== undefined && removeAt > event.timeH) return removeAt - event.timeH;
    const planned = event.extras?.[ExtraKey.patchWearH];
    if (typeof planned === 'number' && Number.isFinite(planned) && planned > 0) return planned;
    return Number.MAX_VALUE;
}

// Model Solver
