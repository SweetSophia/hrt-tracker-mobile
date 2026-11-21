// Feasibility fixture only; never used by the production record hooks.
export interface SqlPort {
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    query(sql: string): Promise<Record<string, unknown>[]>;
    executeSet(statements: { statement: string; values: (string | number)[] }[]): Promise<void>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));
CREATE TABLE IF NOT EXISTS revisions(namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0));
INSERT OR IGNORE INTO revisions VALUES('transfem',0),('transmasc',0),('settings',0);`;

export class BatchQueue {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly sql: SqlPort) {}

    commit(expected: number, value: string, failMidBatch = false): Promise<void> {
        const result = this.tail.then(async () => {
            await this.sql.begin();
            try {
                const rows = await this.sql.query('SELECT revision FROM revisions');
                if (rows.length !== 3 || rows.some(row => row.revision !== expected))
                    throw new Error('REVISION_CONFLICT');
                const statements = ['transfem', 'transmasc', 'settings'].flatMap(namespace => [
                    {
                        statement: 'INSERT OR REPLACE INTO entries(namespace,key,value) VALUES(?,?,?)',
                        values: [namespace, 'synthetic', value],
                    },
                    {
                        statement: 'UPDATE revisions SET revision=? WHERE namespace=?',
                        values: [expected + 1, namespace],
                    },
                ]);
                if (failMidBatch)
                    statements.splice(2, 0, {
                        statement: 'INSERT INTO missing_failure_fixture VALUES(?)',
                        values: ['injected'],
                    });
                await this.sql.executeSet(statements);
                await this.sql.commit();
            } catch (error) {
                await this.sql.rollback();
                throw error;
            }
        });
        this.tail = result.catch(() => undefined);
        return result;
    }
}
