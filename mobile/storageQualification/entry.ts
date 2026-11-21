import { installLongHistoryQualification } from './longHistory';
import { installForecastWorkerQualification } from './forecastWorker';
import { installDemoWorkerQualification } from './demoWorker';
import { installAppEngineWorkerQualification } from './appEngineWorker';
import { installEngineWorkerQualification } from './engineWorker';
import { installBackupQualification } from './nativeBackup';
import { saveQualificationPdf } from './documentUi';
import { installScreenMigration } from './screenMigration';
import { installContentQualification } from './content';
import { registerPlugin } from '@capacitor/core';
import type { ApplicationRuntime } from '../../src/application/runtime';
import { createNativeStores } from '../../src/platform/capacitor';
import { StaleRevisionError, type StoreChange, type StoreSnapshot } from '../../src/platform/contracts';
import { planRecordOperation } from '../../src/records';
import { recordNamespace, PREFERENCES_NAMESPACE } from '../../src/records/scope';
import fixture from '../../tests/fixtures/mobile/storage/record-store-contract-v1.json';

/** Synthetic qualification entry, compiled out of ordinary web/mobile bundles. */
export function installStorageQualification(runtime: ApplicationRuntime) {
    installEngineWorkerQualification();
    const longHistory = installLongHistoryQualification(runtime);
    installAppEngineWorkerQualification(runtime, () => !longHistory.isActive());
    installForecastWorkerQualification();
    installDemoWorkerQualification();
    installBackupQualification();
    installScreenMigration(runtime);
    installContentQualification(runtime);
    const sameSnapshot = (left: StoreSnapshot, right: StoreSnapshot) =>
        left.revision === right.revision &&
        Object.keys(left.entries).length === Object.keys(right.entries).length &&
        Object.entries(left.entries).every(([key, value]) => right.entries[key] === value);
    const raw = registerPlugin<{
        execute(request: unknown): Promise<{ version: number; payload: string }>;
    }>('HrtNativeStorage');
    const run = async (scenario: string, runId: string) => {
        const checks: Record<string, boolean> = {};
        const check = (name: string, okay: boolean) => {
            checks[name] = okay;
            if (!okay) throw new Error('Qualification check failed');
        };
        try {
            if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error('Invalid synthetic identity');
            const { records, secrets } = createNativeStores();
            await records.initialize();
            const owner = `bridge-${runId}`;
            const namespace = recordNamespace({ backend: 'offline', owner, mode: 'transfem' });
            const key = `hrt-u${owner}-events`;
            const token = `qualification-${runId}`;
            if (scenario === 'ping') {
                check('nativeReady', runtime.backend === 'offline');
            } else if (scenario === 'contract') {
                check(
                    'nativeRuntimeReady',
                    runtime.backend === 'offline' && runtime.controller.getState().status === 'ready',
                );
                for (const [index, vector] of fixture.valid.entries()) {
                    const preferences = vector.namespace === PREFERENCES_NAMESPACE;
                    const oldOwner = preferences ? '' : JSON.parse(vector.namespace.slice('records:v1:'.length))[1];
                    const newOwner = `${owner}-${index}-${oldOwner}`;
                    const ns = preferences
                        ? vector.namespace
                        : recordNamespace({ backend: 'offline', owner: newOwner, mode: 'transfem' });
                    const oldPrefix = oldOwner === 'local' ? 'hrt-' : `hrt-u${oldOwner}-`;
                    const values = Object.fromEntries(
                        vector.keys.map(name => [
                            preferences ? name : `hrt-u${newOwner}-` + name.slice(oldPrefix.length),
                            `synthetic-💜-\ud800-\udfff-\u0000-${name}`,
                        ]),
                    );
                    // Avoid changing preferences used by the visible app; an empty dependency
                    // still tests the shared namespace/revision contract through the bridge.
                    const before = await records.read(ns);
                    const puts = preferences ? {} : values;
                    const result = await records.commit([
                        { namespace: ns, expectedRevision: before.revision, puts, removes: [] },
                    ]);
                    check(
                        `fixture${index}`,
                        preferences
                            ? result[ns].revision === before.revision
                            : Object.entries(values).every(([name, value]) => result[ns].entries[name] === value),
                    );
                    check(`reread${index}`, sameSnapshot(await records.read(ns), result[ns]));
                }
                const before = await records.read(namespace);
                const large = 'x'.repeat(3 * 1024 * 1024) + '\ud800💜\udfff';
                const batch: StoreChange[] = [
                    { namespace, expectedRevision: before.revision, puts: { [key]: large }, removes: [] },
                ];
                const ack = await records.commit(batch);
                check('largeExactAck', ack[namespace].entries[key] === large);
                check('largeExactRead', (await records.read(namespace)).entries[key] === large);
                const other = recordNamespace({ backend: 'offline', owner: owner + '-other', mode: 'transfem' });
                const otherBefore = await records.read(other);
                let stale = false;
                try {
                    await records.commit([
                        {
                            namespace: other,
                            expectedRevision: otherBefore.revision,
                            puts: { [`hrt-u${owner}-other-weight`]: '72' },
                            removes: [],
                        },
                        batch[0],
                    ]);
                } catch (error) {
                    stale = error instanceof StaleRevisionError;
                }
                check('staleTyped', stale);
                check('failedBatchAtomic', sameSnapshot(await records.read(other), otherBefore));
                check('credentialsSeparate', !JSON.stringify(ack).includes(token));
                await secrets.set(token, 'synthetic-secret-💜');
                check('secretRoundTrip', (await secrets.get(token)) === 'synthetic-secret-💜');
                await secrets.remove(token);
                check('secretRemoved', (await secrets.get(token)) === null);
                // Invalid requests bypass the TypeScript validation to exercise Java's boundary.
                for (const [index, request] of [
                    { version: '1', operation: 'initialize', payload: '{}' },
                    {
                        version: 1,
                        operation: 'read',
                        payload: JSON.stringify({ namespace: 'records:v1:["foreign","local"]' }),
                    },
                    {
                        version: 1,
                        operation: 'commit',
                        payload: JSON.stringify({ changes: [{ ...batch[0], expectedRevision: 1.5 }] }),
                    },
                    {
                        version: 1,
                        operation: 'commit',
                        payload: JSON.stringify({
                            changes: [{ ...batch[0], expectedRevision: ack[namespace].revision, puts: { [key]: 123 } }],
                        }),
                    },
                    { version: 1, operation: 'read', payload: JSON.stringify({ namespace, path: '/unused' }) },
                ].entries()) {
                    let rejected = false;
                    try {
                        await raw.execute(request);
                    } catch (error) {
                        rejected = (error as { code?: string }).code === 'INVALID_STORAGE_REQUEST';
                    }
                    check(`nativeValidation${index}`, rejected);
                }
                check('invalidWritesUnchanged', sameSnapshot(await records.read(namespace), ack[namespace]));
            } else if (scenario === 'controller') {
                const receipt = await runtime.controller.dispatch(context =>
                    planRecordOperation(context, storage => {
                        storage.setItem('hrt-weight', '72');
                        storage.setItem('app-theme', 'dark');
                    }),
                );
                check('controllerAcknowledged', receipt.active);
                const local = recordNamespace({ backend: 'offline', owner: 'local', mode: 'transfem' });
                check('nativeControllerRecord', (await records.read(local)).entries['hrt-weight'] === '72');
                check(
                    'nativeControllerPreference',
                    (await records.read(PREFERENCES_NAMESPACE)).entries['app-theme'] === 'dark',
                );
                check('publishedPreference', runtime.getState().preferences['app-theme'] === 'dark');
                check(
                    'portableNotInBrowser',
                    localStorage.getItem('hrt-weight') === null && localStorage.getItem('app-theme') === null,
                );
            } else if (scenario === 'write') {
                const before = await records.read(namespace);
                const result = await records.commit([
                    {
                        namespace,
                        expectedRevision: before.revision,
                        puts: { [key]: 'synthetic-restart-record' },
                        removes: [],
                    },
                ]);
                await secrets.set(token, 'synthetic-restart-secret');
                await secrets.set(token + '-removed', 'synthetic-removed');
                await secrets.remove(token + '-removed');
                check('durableAck', result[namespace].entries[key] === 'synthetic-restart-record');
            } else if (scenario === 'read') {
                check('recordReopened', (await records.read(namespace)).entries[key] === 'synthetic-restart-record');
                check('secretReopened', (await secrets.get(token)) === 'synthetic-restart-secret');
                check('removalReopened', (await secrets.get(token + '-removed')) === null);
            } else throw new Error('Unknown qualification scenario');
            return { scenario, runId, outcome: 'pass', checks };
        } catch {
            return { scenario, runId, outcome: 'fail', checks };
        }
    };
    Object.assign(window, {
        __hrtStorageQualification: { run },
        __hrtDocumentQualification: {
            pdf: async () => {
                try {
                    return { outcome: await saveQualificationPdf(runtime.files) };
                } catch {
                    return { outcome: 'failed' };
                }
            },
            pick: async () => {
                try {
                    const result = await runtime.filePicker.pick();
                    return result
                        ? {
                              outcome: 'picked',
                              name: result.name,
                              mimeType: result.mimeType,
                              bytes: Array.from(result.bytes),
                          }
                        : { outcome: 'cancelled' };
                } catch (error) {
                    return { outcome: 'failed', code: (error as { code?: string }).code ?? 'FAILED' };
                }
            },
            save: async (bytes: number[], name = 'synthetic.json', mimeType = 'application/json') => {
                try {
                    return { outcome: await runtime.files.save({ name, mimeType, bytes: new Uint8Array(bytes) }) };
                } catch {
                    return { outcome: 'failed' };
                }
            },
        },
    });
}
