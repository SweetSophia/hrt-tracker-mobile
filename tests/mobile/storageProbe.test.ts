import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { BatchQueue, SCHEMA, type SqlPort } from '../../mobile/probe/batch';

function database() {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    const port: SqlPort = {
        begin: async () => {
            db.exec('BEGIN IMMEDIATE');
        },
        commit: async () => {
            db.exec('COMMIT');
        },
        rollback: async () => {
            db.exec('ROLLBACK');
        },
        query: async sql => db.prepare(sql).all(),
        executeSet: async statements => {
            for (const item of statements) db.prepare(item.statement).run(...item.values);
        },
    };
    return { db, queue: new BatchQueue(port) };
}

it('commits both modes and settings in one revision', async () => {
    const { db, queue } = database();
    try {
        await queue.commit(0, 'synthetic-committed');
        expect(
            db
                .prepare('SELECT value FROM entries')
                .all()
                .map(row => row.value),
        ).toEqual(Array(3).fill('synthetic-committed'));
        expect(
            db
                .prepare('SELECT revision FROM revisions')
                .all()
                .map(row => row.revision),
        ).toEqual([1, 1, 1]);
    } finally {
        db.close();
    }
});

it('rolls back a mid-batch SQL failure and reports rejection', async () => {
    const { db, queue } = database();
    try {
        await queue.commit(0, 'old');
        await expect(queue.commit(1, 'new', true)).rejects.toThrow();
        expect(
            db
                .prepare('SELECT value FROM entries')
                .all()
                .map(row => row.value),
        ).toEqual(['old', 'old', 'old']);
        expect(
            db
                .prepare('SELECT revision FROM revisions')
                .all()
                .map(row => row.revision),
        ).toEqual([1, 1, 1]);
    } finally {
        db.close();
    }
});

it('serializes competing revisions and continues after a conflict', async () => {
    const { db, queue } = database();
    try {
        const results = await Promise.allSettled([queue.commit(0, 'first'), queue.commit(0, 'stale')]);
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
        await queue.commit(1, 'second');
        expect(
            db
                .prepare('SELECT value FROM entries')
                .all()
                .map(row => row.value),
        ).toEqual(Array(3).fill('second'));
    } finally {
        db.close();
    }
});
