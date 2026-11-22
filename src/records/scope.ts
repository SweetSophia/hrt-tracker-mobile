import type { HRTMode } from '../domain/types';
import type { StoreChange, StoreSnapshot } from '../platform/contracts';
import { modeKeyFor, nsFor } from '../utils/backupState';

export interface RecordScope {
    /** Stable backend identity chosen by the adapter; 'offline' for local-only use. */
    readonly backend: string;
    /** Existing upstream storage owner; 'local' is the signed-out owner. */
    readonly owner: string;
    readonly mode: HRTMode;
}
export const PREFERENCES_NAMESPACE = 'preferences:v1';
/** Device-local namespace for the HRT mode selection; native record stores only, never backed up. */
export const DEVICE_PREFERENCES_NAMESPACE = 'device-preferences:v1';
export const PORTABLE_PREFERENCE_KEYS = Object.freeze([
    'app-theme',
    'hrt-lang',
    'app-show-prediction',
    'app-hide-site-label',
    'hrt-supply-lead-days',
]);
const DEVICE_PREFERENCE_KEYS = Object.freeze(['hrt-mode']);
const DEVICE_MODES: readonly string[] = Object.freeze(['transfem', 'transmasc']);
const MODE_SUFFIXES = [
    'events',
    'lab-results',
    'dose-templates',
    'deletions',
    'quick-doses',
    'supplies',
    'plan',
    'plan-at',
];
const SHARED_SUFFIXES = [
    'weight',
    'weight-at',
    'birth-year',
    'birth-year-at',
    'pk-params',
    'pk-params-at',
    'cal-method',
    'cal-history-mode',
    'age-beta',
    'model-settings-at',
    'cpa-plan',
];

export function recordNamespace(scope: RecordScope): string {
    if (
        typeof scope.backend !== 'string' ||
        !scope.backend ||
        typeof scope.owner !== 'string' ||
        !scope.owner ||
        (scope.mode !== 'transfem' && scope.mode !== 'transmasc')
    )
        throw new Error('Invalid record scope');
    return `records:v1:${JSON.stringify([scope.backend, scope.owner])}`;
}
export const namespacesFor = (scope: RecordScope): readonly string[] => [recordNamespace(scope), PREFERENCES_NAMESPACE];

export function allowedKeys(namespace: string): ReadonlySet<string> {
    if (namespace === PREFERENCES_NAMESPACE) return new Set(PORTABLE_PREFERENCE_KEYS);
    if (namespace === DEVICE_PREFERENCES_NAMESPACE) return new Set(DEVICE_PREFERENCE_KEYS);
    if (!namespace.startsWith('records:v1:')) throw new Error('Invalid record namespace');
    const parts: unknown = JSON.parse(namespace.slice('records:v1:'.length));
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== 'string' || !p)) {
        throw new Error('Invalid record namespace');
    }
    const scope: RecordScope = { backend: parts[0], owner: parts[1], mode: 'transfem' };
    if (recordNamespace(scope) !== namespace) throw new Error('Noncanonical record namespace');
    return new Set([
        ...SHARED_SUFFIXES.map(suffix => nsFor(scope.owner, suffix)),
        ...(['transfem', 'transmasc'] as const).flatMap(mode =>
            MODE_SUFFIXES.map(suffix => modeKeyFor(scope.owner, mode, suffix)),
        ),
    ]);
}
function revision(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid store revision');
}
export function validateSnapshot(namespace: string, snapshot: StoreSnapshot): void {
    revision(snapshot.revision);
    const keys = allowedKeys(namespace);
    if (!snapshot.entries || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries))
        throw new Error('Invalid entries');
    for (const [key, value] of Object.entries(snapshot.entries)) {
        if (!keys.has(key) || typeof value !== 'string') throw new Error('Invalid record entry');
        if (namespace === DEVICE_PREFERENCES_NAMESPACE && !DEVICE_MODES.includes(value))
            throw new Error('Invalid record entry');
    }
}
export function validateChange(change: StoreChange): void {
    validateSnapshot(change.namespace, { revision: change.expectedRevision, entries: change.puts });
    if (!Array.isArray(change.removes)) throw new Error('Invalid removes');
    const keys = allowedKeys(change.namespace);
    const seen = new Set(Object.keys(change.puts));
    for (const key of change.removes) {
        if (!keys.has(key) || seen.has(key)) throw new Error('Invalid or duplicate record removal');
        seen.add(key);
    }
}
