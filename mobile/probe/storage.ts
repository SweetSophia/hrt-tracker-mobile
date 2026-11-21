import { CapacitorSQLite as sqlite } from '@capacitor-community/sqlite';
import { randomBytes } from '../../src/utils/cryptoCompat';
import { BatchQueue, SCHEMA, type SqlPort } from './batch';
import type { ProbeRequest } from './contracts';

const database = 'hrt_feasibility';
const options = { database, readonly: false };
const sentinel = 'SYNTHETIC_ENCRYPTED_SENTINEL_ASKARYS';
const query = async (statement: string) => (await sqlite.query({ ...options, statement, values: [] })).values ?? [];
const execute = async (statements: string) => {
    await sqlite.execute({ ...options, statements, transaction: false });
};
const port: SqlPort = {
    begin: async () => {
        await sqlite.beginTransaction(options);
    },
    commit: async () => {
        await sqlite.commitTransaction(options);
    },
    rollback: async () => {
        if ((await sqlite.isTransactionActive(options)).result) await sqlite.rollbackTransaction(options);
    },
    query,
    executeSet: async set => {
        await sqlite.executeSet({ ...options, set, transaction: false });
    },
};

export async function storageProbe(request: ProbeRequest) {
    let stage = 'SECRET';
    try {
        const checks: Record<string, boolean> = {};
        const secret = (await sqlite.isSecretStored()).result;
        const exists = (await sqlite.isDatabase(options)).result;
        if (!secret) {
            if (exists || request.phase !== 'prepare') throw new Error('MISSING_SECRET_NO_REGENERATION');
            // Candidate path under test, NOT a qualified durable secret store.
            await sqlite.setEncryptionSecret({ passphrase: btoa(String.fromCharCode(...randomBytes(32))) });
        }
        stage = 'OPEN';
        await sqlite.createConnection({ ...options, encrypted: true, mode: 'secret', version: 1 });
        await sqlite.open(options);
        stage = 'PRAGMA';
        await query('PRAGMA journal_mode=WAL');
        await execute('PRAGMA synchronous=FULL;');
        const cipher = await query('PRAGMA cipher_version');
        const versions = {
            sqlcipher: String(cipher[0]?.cipher_version ?? ''),
            journalMode: String((await query('PRAGMA journal_mode'))[0]?.journal_mode ?? ''),
            synchronous: String((await query('PRAGMA synchronous'))[0]?.synchronous ?? ''),
            sqlitePlugin: '8.1.1',
        };
        stage = 'CIPHER_CHECK';
        checks.encryptedEngine =
            versions.sqlcipher.length > 0 && (await sqlite.isDatabaseEncrypted(options)).result === true;
        const snapshot = async () =>
            JSON.stringify({
                entries: await query('SELECT * FROM entries ORDER BY namespace,key'),
                revisions: await query('SELECT * FROM revisions ORDER BY namespace'),
            });
        if (request.phase === 'cleanup') {
            await sqlite.close(options);
            await sqlite.closeConnection(options);
            return { checks: { closed: true }, versions, outcome: 'pass' as const };
        }
        if (request.phase === 'prepare' && request.scenario === 'sqlite-batch') {
            stage = 'SCHEMA';
            await execute(SCHEMA);
            stage = 'RESET';
            await port.executeSet([
                { statement: 'DELETE FROM entries', values: [] },
                { statement: 'UPDATE revisions SET revision=0', values: [] },
            ]);
            const queue = new BatchQueue(port);
            stage = 'INITIAL_COMMIT';
            await queue.commit(0, 'old-synthetic');
            stage = 'ROLLBACK_TEST';
            const before = await snapshot();
            let failed = false;
            try {
                await queue.commit(1, 'injected-write', true);
            } catch {
                failed = true;
            }
            checks.injectedWriteRejected = failed;
            checks.rollback = before === (await snapshot());
            stage = 'CONFLICT_TEST';
            const competing = await Promise.allSettled([
                queue.commit(1, 'competing-winner'),
                queue.commit(1, 'competing-stale'),
            ]);
            checks.revisionConflict = competing[0].status === 'fulfilled' && competing[1].status === 'rejected';
            checks.serialized = (await query('SELECT value FROM entries')).every(
                row => row.value === 'competing-winner',
            );
            stage = 'ACKNOWLEDGED_COMMIT';
            await queue.commit(2, sentinel);
            checks.commitAcknowledged = true;
            return { checks, versions, outcome: 'ready' as const };
        }
        stage = 'VERIFY_REOPEN';
        const rows = await query('SELECT value FROM entries');
        const revisions = await query('SELECT revision FROM revisions');
        checks.acknowledgedBatchSurvived =
            rows.length === 3 &&
            rows.every(row => row.value === sentinel) &&
            revisions.length === 3 &&
            revisions.every(row => row.revision === 3);
        if (request.phase === 'prepare' && request.scenario === 'sqlite-key') {
            await port.begin();
            await port.executeSet([
                {
                    statement: "UPDATE entries SET value='SYNTHETIC_UNCOMMITTED' WHERE namespace='transfem'",
                    values: [],
                },
                { statement: "UPDATE revisions SET revision=4 WHERE namespace='transfem'", values: [] },
            ]);
            checks.preCommitCheckpoint =
                (await sqlite.isTransactionActive(options)).result === true &&
                (await query("SELECT revision FROM revisions WHERE namespace='transfem'"))[0]?.revision === 4 &&
                (await query("SELECT value FROM entries WHERE namespace='transfem'"))[0]?.value ===
                    'SYNTHETIC_UNCOMMITTED';
            // Host kills this process at the returned checkpoint, without closing.
            return { checks, versions, outcome: 'ready' as const };
        }
        await sqlite.close(options);
        await sqlite.closeConnection(options);
        return { checks, versions, outcome: 'pass' as const };
    } catch {
        throw new Error('SQLITE_PROBE_' + stage);
    }
}
