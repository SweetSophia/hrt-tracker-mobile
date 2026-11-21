import { expect, it } from 'vitest';
import { removeBackupQualificationSecrets } from '../../mobile/storageQualification/nativeBackup';

it('removes only the two lifecycle credentials after recovery verification', async () => {
    const values = new Map([
        ['synthetic-backup-local', 'synthetic'],
        ['synthetic-backup-synthetic-account', 'synthetic'],
        ['unrelated', 'keep'],
    ]);
    await removeBackupQualificationSecrets({
        get: async key => values.get(key) ?? null,
        set: async (key, value) => {
            values.set(key, value);
        },
        remove: async key => {
            values.delete(key);
        },
    });
    expect([...values.entries()]).toEqual([['unrelated', 'keep']]);
});
it('does not report successful cleanup when a secret remains', async () => {
    await expect(
        removeBackupQualificationSecrets({ get: async () => 'synthetic', set: async () => {}, remove: async () => {} }),
    ).rejects.toThrow('Synthetic secret cleanup failed');
});
