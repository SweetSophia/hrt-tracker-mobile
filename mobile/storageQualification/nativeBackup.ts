import type { SecretStore } from '../../src/platform/contracts';
import { createNativeStores } from '../../src/platform/capacitor';
import { backupLifecycle, runBackupQualification } from './backup';

/** Run only after every lifecycle reopen succeeded; failures retain synthetic evidence. */
export async function removeBackupQualificationSecrets(secrets: SecretStore) {
    for (const owner of ['local', 'synthetic-account']) {
        const key = `synthetic-backup-${owner}`;
        await secrets.remove(key);
        if ((await secrets.get(key)) !== null) throw new Error('Synthetic secret cleanup failed');
    }
}

/** Only the explicitly built storage-qualification application installs this hook. */
export function installBackupQualification() {
    Object.assign(window, {
        __hrtBackupQualification: {
            run: async (phase: string, owner: string) => {
                try {
                    if (owner !== 'local' && owner !== 'synthetic-account')
                        throw new Error('Unsupported qualification owner');
                    const { records, secrets } = createNativeStores();
                    if (phase === 'cleanup') {
                        await removeBackupQualificationSecrets(secrets);
                        return { outcome: 'pass', checks: { syntheticSecretsRemoved: true } };
                    }
                    const key = `synthetic-backup-${owner}`;
                    if (phase === 'seed') await secrets.set(key, 'synthetic-secret-survives-restore');
                    const report =
                        phase === 'compatibility'
                            ? await runBackupQualification(records, owner)
                            : await backupLifecycle(records, owner, phase);
                    if (phase !== 'compatibility' && (await secrets.get(key)) !== 'synthetic-secret-survives-restore')
                        throw new Error('Synthetic secret changed');
                    return { outcome: 'pass', ...report };
                } catch (error) {
                    return { outcome: 'fail', reason: error instanceof Error ? error.message : 'Qualification failed' };
                }
            },
        },
    });
}
