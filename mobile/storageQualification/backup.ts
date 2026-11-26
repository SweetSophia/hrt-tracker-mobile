/** Synthetic-only conformance harness. Never imported by an ordinary application build. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { RecordController } from '../../src/application/recordController';
import type { RecordStore, StoreSnapshots } from '../../src/platform/contracts';
import { WebRecordStore } from '../../src/platform/web/recordStore';
import { planCompleteBackup, planRecordOperation, type RecordContext } from '../../src/records';
import {
    assertReview,
    exportRecordState,
    readRecordState,
    reviewBinding,
    planLegacyImport,
    prepareLegacyImport,
} from '../../src/records/commands';
import { PREFERENCES_NAMESPACE } from '../../src/records/scope';
import { nsFor, MAX_IMPORT_ENTRIES } from '../../src/utils/backupState';
import {
    buildCompleteBackupBundleReportFromStorage,
    inspectCompleteBackupBundle,
    completeBackupAccountTag,
} from '../../src/utils/backupBundle';
import { decryptData, encryptData } from '../../src/domain/crypto';
import {
    MAX_DECOMPRESSED_BACKUP_BYTES,
    decompressGzipWithLimit,
    pipeThrough,
} from '../../src/services/boundedDecompression';
import { MAX_DOCUMENT_BYTES } from '../../src/platform/contracts/files';
import type { Tombstones } from '../../src/utils/sync/types';
import complete from '../../tests/fixtures/mobile/backups/complete-v1.json';
import legacy from '../../tests/fixtures/mobile/backups/legacy-v1.json';
import v2 from '../../tests/fixtures/mobile/backups/records-v2.json';
import encrypted from '../../tests/fixtures/mobile/backups/encrypted-v1.json';

export const BACKUP_NOW = Date.UTC(2030, 0, 2);
const password = 'synthetic-qualification-password';
const createdAt = '2030-01-02T00:00:00.000Z';
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return (
            '{' +
            Object.entries(value)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
                .join(',') +
            '}'
        );
    return JSON.stringify(value);
}
const digest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
export function memoryStore() {
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
        removeItem: (key: string) => {
            values.delete(key);
        },
    };
    return { storage, store: new WebRecordStore(storage, 'offline') };
}
export function confirmed(controller: RecordController): RecordContext {
    const state = controller.getState();
    if (state.status !== 'ready') throw new Error('Qualification controller is not ready');
    return state;
}
async function open(store: RecordStore, owner: string) {
    if (owner !== 'local' && !/^synthetic-[a-z0-9-]{1,60}$/.test(owner)) throw new Error('Synthetic scope required');
    const controller = new RecordController(store);
    await controller.activate({ backend: 'offline', owner, mode: 'transfem' });
    return controller;
}
async function clear(controller: RecordController) {
    await controller.dispatch(context => ({
        changes: Object.entries(context.snapshots).map(([namespace, snapshot]) => ({
            namespace,
            expectedRevision: snapshot.revision,
            puts: {},
            removes: Object.keys(snapshot.entries),
        })),
        result: undefined,
    }));
}
export function exportComplete(context: RecordContext) {
    return planRecordOperation(context, storage =>
        buildCompleteBackupBundleReportFromStorage(
            storage,
            context.scope.owner,
            context.scope.mode,
            readRecordState(context),
            createdAt,
            BACKUP_NOW,
        ),
    ).result;
}
function preview(context: RecordContext, raw: unknown) {
    return planRecordOperation(context, storage =>
        inspectCompleteBackupBundle(raw, {
            storage,
            owner: context.scope.owner,
            mode: context.scope.mode,
            active: readRecordState(context),
            now: BACKUP_NOW,
        }),
    ).result;
}
async function replace(controller: RecordController, raw: unknown, now = BACKUP_NOW) {
    return controller.dispatch(context => planCompleteBackup(context, raw, 'replace', now));
}
const failure = async (operation: () => unknown | Promise<unknown>) => {
    try {
        await operation();
        return false;
    } catch {
        return true;
    }
};

export async function runBackupQualification(store: RecordStore, owner: string) {
    const checks: Record<string, boolean> = {};
    const check = (name: string, value: boolean) => {
        checks[name] = value;
        if (!value) throw new Error(`Backup qualification: ${name}`);
    };
    const controller = await open(store, owner);
    await clear(controller);
    const web = await open(memoryStore().store, owner);
    await replace(web, complete);
    const source = exportComplete(confirmed(web));
    check('webExportNoWarnings', source.issues.length === 0 && source.droppedRecords === 0);
    // Pin semantic content independently of the round-trip comparison below.
    check(
        'allCategoriesAndBothModes',
        (['transfem', 'transmasc'] as const).every(mode => {
            const actual = source.bundle.modes[mode];
            return (
                ['events', 'labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan', 'deletions'] as const
            ).every(category => canonical(actual[category]) === canonical(complete.modes[mode][category]));
        }),
    );
    const raw = JSON.parse(JSON.stringify(source.bundle));
    const beforePreview = canonical(confirmed(controller).snapshots);
    const inspected = preview(confirmed(controller), raw);
    check('previewReadable', inspected.ok && inspected.blocked.length === 0);
    check('previewAndCancellationNoWrite', canonical(confirmed(controller).snapshots) === beforePreview);
    await controller.refresh();
    check('cancelDurableUnchanged', canonical(confirmed(controller).snapshots) === beforePreview);
    await replace(controller, raw);
    const mobile = exportComplete(confirmed(controller));
    check('mobileExportNoWarnings', mobile.issues.length === 0);
    check(
        'portablePreferencesPinned',
        canonical(source.bundle.preferences) === canonical(complete.preferences) &&
            canonical(confirmed(controller).snapshots[PREFERENCES_NAMESPACE].entries) ===
                canonical(
                    Object.fromEntries(
                        Object.entries(complete.preferences).map(([key, value]) => [key, String(value)]),
                    ),
                ),
    );
    check('webToNativeExact', canonical(mobile.bundle) === canonical(source.bundle));
    const back = await open(memoryStore().store, owner);
    await replace(back, JSON.parse(JSON.stringify(mobile.bundle)));
    check('nativeToWebExact', canonical(exportComplete(confirmed(back)).bundle) === canonical(source.bundle));
    const roundTripDigest = digest(mobile.bundle);
    const stable = canonical(confirmed(controller).snapshots);
    const malformed = structuredClone(raw);
    malformed.modes.transfem.events = [{}];
    check('malformedCategoryBlocked', preview(confirmed(controller), malformed).blocked.includes('transfem.events'));
    check('malformedReplaceRejected', await failure(() => replace(controller, malformed)));
    check('unknownVersionRejected', await failure(() => replace(controller, { ...raw, formatVersion: 99 })));
    check('failedReplaceUnchanged', canonical(confirmed(controller).snapshots) === stable);
    // Only the event under examination is present: unrelated unstamped categories
    // and identical labs/templates must not satisfy conflict/skip assertions.
    const original = raw.modes.transfem.events[0];
    const eventOnly = (event: typeof original) => ({
        format: raw.format,
        formatVersion: raw.formatVersion,
        createdAt: raw.createdAt,
        mode: raw.mode,
        modes: { transfem: { events: [event] }, transmasc: {} },
        calibration: raw.calibration,
    });
    const conflict = eventOnly({ ...original, doseMG: original.doseMG + 1 });
    const conflicted = preview(confirmed(controller), conflict);
    check(
        'equalTimestampConflict',
        canonical(conflicted.blocked) === canonical(['transfem.events']) &&
            canonical(conflicted.conflicts) ===
                canonical([`transfem.events: id ${original.id} has equal updatedAt but different content`]) &&
            canonical(conflicted.stats) === canonical({ added: 0, updated: 0, skipped: 0, removed: 0 }),
    );
    await controller.dispatch(context => planCompleteBackup(context, conflict, 'merge', BACKUP_NOW));
    await controller.refresh();
    check('conflictKeptLocal', canonical(exportComplete(confirmed(controller)).bundle) === canonical(source.bundle));
    const older = eventOnly({ ...original, doseMG: original.doseMG + 1, updatedAt: original.updatedAt - 1 });
    const skipped = preview(confirmed(controller), older);
    check(
        'newerLocalSkipped',
        skipped.blocked.length === 0 &&
            skipped.conflicts.length === 0 &&
            canonical(skipped.stats) === canonical({ added: 0, updated: 0, skipped: 1, removed: 0 }),
    );
    await controller.dispatch(context => planCompleteBackup(context, older, 'merge', BACKUP_NOW));
    await controller.refresh();
    check('olderMergeKeptLocal', canonical(exportComplete(confirmed(controller)).bundle) === canonical(source.bundle));
    const merged = structuredClone(raw);
    const mergedModes: Partial<Record<'transfem' | 'transmasc', { events: unknown[] }>> = {};
    const positive = {
        format: raw.format,
        formatVersion: raw.formatVersion,
        createdAt: raw.createdAt,
        mode: raw.mode,
        calibration: raw.calibration,
        modes: mergedModes,
        weight: 74,
        weightUpdatedAt: BACKUP_NOW + 1,
    };
    for (const mode of ['transfem', 'transmasc'] as const) {
        const previous = raw.modes[mode].events[0];
        const events = [
            { ...previous, doseMG: previous.doseMG + 1, updatedAt: BACKUP_NOW },
            { ...previous, id: `synthetic-merged-${mode}`, doseMG: previous.doseMG + 2, updatedAt: BACKUP_NOW },
        ];
        mergedModes[mode] = { events };
        merged.modes[mode].events = events;
    }
    merged.weight = positive.weight;
    merged.weightUpdatedAt = positive.weightUpdatedAt;
    const added = preview(confirmed(controller), positive);
    check(
        'positiveMergePreview',
        added.blocked.length === 0 &&
            added.conflicts.length === 0 &&
            canonical(added.stats) === canonical({ added: 2, updated: 2, skipped: 0, removed: 0 }) &&
            added.scalars.weight?.action === 'updated',
    );
    await controller.dispatch(context => planCompleteBackup(context, positive, 'merge', BACKUP_NOW));
    await controller.refresh();
    check('positiveMergeDurable', canonical(exportComplete(confirmed(controller)).bundle) === canonical(merged));
    check(
        'accountMismatchVisible',
        preview(confirmed(controller), {
            ...raw,
            sourceAccount: completeBackupAccountTag('synthetic-different-account'),
        }).account === (owner === 'local' ? 'unknown' : 'other'),
    );
    const binding = reviewBinding(confirmed(controller));
    await controller.dispatch(context =>
        planRecordOperation(context, storage => storage.setItem('app-theme', 'light')),
    );
    const afterEdit = canonical(confirmed(controller).snapshots);
    check(
        'staleReviewRejected',
        await failure(() =>
            controller.dispatch(context => {
                assertReview(context, binding);
                return planCompleteBackup(context, raw, 'replace', BACKUP_NOW);
            }),
        ),
    );
    check('staleReviewNoWrite', canonical(confirmed(controller).snapshots) === afterEdit);
    const empty = await open(memoryStore().store, owner);
    const maximum = structuredClone(raw);
    maximum.modes.transfem.events = Array.from({ length: MAX_IMPORT_ENTRIES }, (_, i) => ({
        ...raw.modes.transfem.events[0],
        id: `synthetic-bound-${i}`,
    }));
    check('twentyThousandAccepted', preview(confirmed(empty), maximum).blocked.length === 0);
    maximum.modes.transfem.events.push({ ...maximum.modes.transfem.events[0], id: 'synthetic-over-limit' });
    check('overEntryLimitBlocked', preview(confirmed(empty), maximum).blocked.includes('transfem.events'));
    check('overEntryLimitReplaceRejected', await failure(() => replace(controller, maximum)));
    check(
        'configuredLimitsPinned',
        MAX_IMPORT_ENTRIES === 20_000 &&
            MAX_DOCUMENT_BYTES === 16 * 1024 * 1024 &&
            MAX_DECOMPRESSED_BACKUP_BYTES === 64 * 1024 * 1024,
    );
    const gzip = await pipeThrough(new Uint8Array(1025), new CompressionStream('gzip'));
    check('decompressionBounded', await failure(() => decompressGzipWithLimit(gzip, 1024)));
    check('decompressionExactLimit', (await decompressGzipWithLimit(gzip, 1025)).byteLength === 1025);
    const decrypted = await decryptData(JSON.stringify(encrypted), password);
    check('frozenEncryptedImport', decrypted !== null && canonical(JSON.parse(decrypted)) === canonical(complete));
    const sealed = await encryptData(JSON.stringify(mobile.bundle), password);
    check(
        'newEncryptedExportReopens',
        canonical(JSON.parse((await decryptData(sealed.data, password))!)) === canonical(mobile.bundle),
    );
    // A wrong password is expected to be rejected by the shared upstream decoder.
    check('wrongPasswordRejected', (await decryptData(JSON.stringify(encrypted), 'synthetic-wrong-password')) === null);
    for (const [label, input] of [
        ['legacy', legacy],
        ['v2', v2],
        ['encryptedComplete', JSON.parse(decrypted!)],
    ] as const) {
        await clear(controller);
        await clear(web);
        for (const target of [web, controller]) {
            if (label === 'encryptedComplete') await replace(target, input);
            else
                await target.dispatch(context =>
                    planLegacyImport(
                        context,
                        prepareLegacyImport(input, BACKUP_NOW, () => {
                            throw new Error('Frozen fixtures must have IDs');
                        }),
                        'replace',
                        BACKUP_NOW,
                    ),
                );
        }
        check(
            `${label}WebNativeParity`,
            canonical(readRecordState(confirmed(controller))) === canonical(readRecordState(confirmed(web))),
        );
        for (const mode of ['transfem', 'transmasc'] as const) {
            const left = { ...confirmed(controller), scope: { ...confirmed(controller).scope, mode } };
            const right = { ...confirmed(web), scope: { ...confirmed(web).scope, mode } };
            check(
                `${label}${mode}ExportParity`,
                canonical(exportComplete(left).bundle) === canonical(exportComplete(right).bundle),
            );
            if (label !== 'encryptedComplete') {
                const expected =
                    label === 'v2'
                        ? v2.modes[mode]
                        : {
                              events: mode === 'transfem' ? legacy : [],
                              labResults: [],
                              doseTemplates: [],
                          };
                const actual = readRecordState(left);
                check(
                    `${label}${mode}FieldsPinned`,
                    (['events', 'labResults', 'doseTemplates'] as const).every(
                        category => canonical(actual[category]) === canonical(expected[category]),
                    ),
                );
            }
        }
        if (label !== 'encryptedComplete') {
            const state = readRecordState(confirmed(controller));
            check(
                `${label}ScalarsPinned`,
                state.weight === (label === 'v2' ? 72 : 70) &&
                    state.birthYear === (label === 'v2' ? 1980 : null) &&
                    state.pkParams === null,
            );
            // These omissions are current upstream behavior, not claims of full migration.
            // A later intentional importer enhancement must update this compatibility contract.
            check(
                `${label}OmissionsPinned`,
                exportRecordState(confirmed(controller)).modelSettings === undefined &&
                    (['transfem', 'transmasc'] as const).every(mode => {
                        const block = exportComplete(confirmed(controller)).bundle.modes[mode];
                        return (
                            block.plan?.length === 0 &&
                            canonical(block.deletions) === canonical({ events: {}, labResults: {}, doseTemplates: {} })
                        );
                    }),
            );
        }
    }
    // Legacy browser adoption is exercised before native import, never by copying localStorage wholesale.
    for (const [alias, normalized] of [
        ['average', 'mipd'],
        ['adaptive', 'ekf'],
    ] as const) {
        const legacyWeb = memoryStore();
        legacyWeb.storage.setItem('app-age-beta', 'true');
        legacyWeb.storage.setItem(nsFor(owner, 'cpa-plan'), '{"plan":"alternate"}');
        legacyWeb.storage.setItem(nsFor(owner, 'cal-method'), alias);
        for (const name of [
            'auth_token',
            'weak_password',
            'enc_key',
            'hrt-cloud-key',
            'app-auto-backup',
            'app-dev-mode',
        ])
            legacyWeb.storage.setItem(name, 'synthetic-excluded');
        const migrated = await open(legacyWeb.store, owner);
        check(
            `${alias}Adopted`,
            readRecordState(confirmed(migrated)).ageBeta &&
                readRecordState(confirmed(migrated)).calibrationMethod === normalized,
        );
        const exported = exportComplete(confirmed(migrated));
        check(`${alias}CpaAlias`, exported.bundle.modes.transfem.plan?.[0]?.id === 'cpa');
        check(
            `${alias}NoSecrets`,
            !canonical(exported.bundle).includes('synthetic-excluded') &&
                !canonical(exportRecordState(confirmed(migrated))).includes('synthetic-excluded'),
        );
        await clear(controller);
        await replace(controller, exported.bundle);
        check(
            `${alias}NativeImport`,
            canonical(exportComplete(confirmed(controller)).bundle) === canonical(exported.bundle),
        );
    }
    return { checks, digest: roundTripDigest };
}

function replacementFixture() {
    const next = structuredClone(complete);
    next.preferences['app-theme'] = 'light';
    (next.preferences as Record<string, unknown>)['app-palette'] = 'plum';
    next.weight = 78;
    next.calibration = { method: 'mipd', historyMode: 'retrospective' };
    next.modes.transmasc.events = Array.from({ length: MAX_IMPORT_ENTRIES }, (_, i) => ({
        ...next.modes.transmasc.events![0],
        id: `synthetic-restored-${i}`,
    }));
    next.modes.transmasc.quickDoses = [];
    for (const category of ['events', 'labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan'] as const)
        next.modes.transfem[category] = [];
    return { ...next, pkParams: null };
}
/** A separate semantic oracle: do not let an incorrect planner define its own success. */
function assertReplacementSemantics(context: RecordContext) {
    const report = exportComplete(context);
    if (report.issues.length) throw new Error('Replacement export has warnings');
    const actual = report.bundle;
    const expected = replacementFixture();
    for (const mode of ['transfem', 'transmasc'] as const) {
        for (const category of ['events', 'labResults', 'doseTemplates', 'quickDoses', 'supplies', 'plan'] as const) {
            if (canonical(actual.modes[mode][category]) !== canonical(expected.modes[mode][category]))
                throw new Error(`Replacement category mismatch: ${mode}.${category}`);
        }
        const tombstones: Tombstones = structuredClone(complete.modes[mode].deletions);
        for (const category of ['events', 'labResults', 'doseTemplates'] as const) {
            const retained = new Set(expected.modes[mode][category].map(record => record.id));
            for (const record of complete.modes[mode][category]) {
                if (!retained.has(record.id)) tombstones[category][record.id] = BACKUP_NOW;
            }
        }
        if (canonical(actual.modes[mode].deletions) !== canonical(tombstones))
            throw new Error(`Replacement tombstone mismatch: ${mode}`);
    }
    for (const key of [
        'weight',
        'weightUpdatedAt',
        'pkParams',
        'pkParamsUpdatedAt',
        'calibration',
        'preferences',
    ] as const) {
        if (canonical(actual[key]) !== canonical(expected[key]))
            throw new Error(`Replacement setting mismatch: ${key}`);
    }
}
export async function backupLifecycle(store: RecordStore, owner: string, phase: string) {
    const controller = await open(store, owner);
    if (phase === 'seed') {
        await clear(controller);
        // Old scalar stamps must differ from the restore clock, or omitted writes can pass.
        await replace(controller, complete, BACKUP_NOW - 1_000);
        const context = confirmed(controller);
        const plan = planCompleteBackup(context, replacementFixture(), 'replace', BACKUP_NOW);
        const after: StoreSnapshots = Object.fromEntries(
            plan.changes.map(change => {
                const previous = context.snapshots[change.namespace];
                const entries = { ...previous.entries, ...change.puts };
                for (const key of change.removes) delete entries[key];
                return [
                    change.namespace,
                    {
                        revision:
                            previous.revision + (Object.keys(change.puts).length || change.removes.length ? 1 : 0),
                        entries,
                    },
                ];
            }),
        );
        assertReplacementSemantics({ ...context, snapshots: after });
        return { before: digest(context.snapshots), after: digest(after), replacementSemanticsVerified: true };
    }
    if (phase === 'replace') {
        await replace(controller, replacementFixture());
        assertReplacementSemantics(confirmed(controller));
    } else if (phase !== 'verify') throw new Error('Unknown backup lifecycle phase');
    return { digest: digest(confirmed(controller).snapshots) };
}
