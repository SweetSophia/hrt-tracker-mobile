import { expect, it, vi } from 'vitest';
import * as records from '../../src/records';
import complete from '../fixtures/mobile/backups/complete-v1.json';
import expectedChecks from '../fixtures/mobile/backups/checks-v1.json';
import { WebRecordStore } from '../../src/platform/web/recordStore';
import { MemoryStorage } from '../memoryStorage';
import { runBackupQualification, backupLifecycle } from '../../mobile/storageQualification/backup';

it.each(['local', 'synthetic-account'])(
    'preserves shared backup semantics for %s',
    async owner => {
        const report = await runBackupQualification(new WebRecordStore(new MemoryStorage(), 'offline'), owner);
        expect(Object.keys(report.checks).sort()).toEqual([...expectedChecks].sort());
        expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
    },
    30_000,
);

it.each(['local', 'synthetic-account'])(
    'verifies every entry of complete replacement for %s',
    async owner => {
        const store = new WebRecordStore(new MemoryStorage(), 'offline');
        const seeded = await backupLifecycle(store, owner, 'seed');
        expect(seeded.replacementSemanticsVerified).toBe(true);
        expect(seeded.before).not.toBe(seeded.after);
        expect((await backupLifecycle(store, owner, 'verify')).digest).toBe(seeded.before);
        await backupLifecycle(store, owner, 'replace');
        expect((await backupLifecycle(store, owner, 'verify')).digest).toBe(seeded.after);
    },
    30_000,
);

it.each([
    ['hrt-events', JSON.stringify(complete.modes.transfem.events), 'category'],
    ['hrt-deletions', '{"events":{},"labResults":{},"doseTemplates":{}}', 'tombstone'],
    ['hrt-weight', '77', 'setting'],
])('rejects a planner that produces the wrong %s value', async (key, value, message) => {
    await expect(
        backupLifecycle(new WebRecordStore(new MemoryStorage(), 'offline'), 'local', 'seed'),
    ).resolves.toHaveProperty('replacementSemanticsVerified', true);
    const original = records.planCompleteBackup;
    const spy = vi.spyOn(records, 'planCompleteBackup').mockImplementation((context, raw, strategy, now) => {
        const planned = original(context, raw, strategy, now);
        if ((raw as { weight?: number }).weight === 78) {
            return {
                ...planned,
                changes: planned.changes.map((change, index) =>
                    index === 0 ? { ...change, puts: { ...change.puts, [key]: value } } : change,
                ),
            };
        }
        return planned;
    });
    try {
        await expect(
            backupLifecycle(new WebRecordStore(new MemoryStorage(), 'offline'), 'local', 'seed'),
        ).rejects.toThrow(`Replacement ${message} mismatch`);
    } finally {
        spy.mockRestore();
    }
});

it.each(['hrt-weight-at', 'hrt-pk-params-at'])('rejects a planner that fails to restamp %s', async key => {
    await expect(
        backupLifecycle(new WebRecordStore(new MemoryStorage(), 'offline'), 'local', 'seed'),
    ).resolves.toHaveProperty('replacementSemanticsVerified', true);
    const original = records.planCompleteBackup;
    const spy = vi.spyOn(records, 'planCompleteBackup').mockImplementation((context, raw, strategy, now) => {
        const planned = original(context, raw, strategy, now);
        if ((raw as { weight?: number }).weight !== 78) return planned;
        return {
            ...planned,
            changes: planned.changes.map(change => {
                const puts = { ...change.puts };
                delete puts[key];
                return { ...change, puts };
            }),
        };
    });
    try {
        await expect(
            backupLifecycle(new WebRecordStore(new MemoryStorage(), 'offline'), 'local', 'seed'),
        ).rejects.toThrow('Replacement setting mismatch');
    } finally {
        spy.mockRestore();
    }
});

it.each(['ignored merge', 'missing event conflict', 'older event overwritten'])(
    'rejects qualification with %s',
    async defect => {
        const store = () => new WebRecordStore(new MemoryStorage(), 'offline');
        // Positive control stays in this probe, so unrelated oracle failures cannot satisfy it.
        await expect(runBackupQualification(store(), 'local')).resolves.toHaveProperty('digest');
        const bundle = await import('../../src/utils/backupBundle');
        const originalPlan = records.planCompleteBackup;
        const originalPreview = bundle.inspectCompleteBackupBundle;
        const previewSpy = vi.spyOn(bundle, 'inspectCompleteBackupBundle').mockImplementation((raw, context) => {
            const report = originalPreview(raw, context);
            return defect === 'missing event conflict'
                ? { ...report, conflicts: report.conflicts.filter(value => !value.startsWith('transfem.events:')) }
                : report;
        });
        const planSpy = vi.spyOn(records, 'planCompleteBackup').mockImplementation((context, raw, strategy, now) => {
            const plan = originalPlan(context, raw, strategy, now);
            if (strategy !== 'merge') return plan;
            if (defect === 'ignored merge')
                return {
                    ...plan,
                    changes: plan.changes.map(change => ({ ...change, puts: {}, removes: [] })),
                };
            const events = (raw as typeof complete).modes?.transfem?.events;
            if (
                defect === 'older event overwritten' &&
                events?.[0]?.updatedAt < complete.modes.transfem.events[0].updatedAt
            )
                return {
                    ...plan,
                    changes: plan.changes.map((change, index) =>
                        index === 0
                            ? { ...change, puts: { ...change.puts, 'hrt-events': JSON.stringify(events) } }
                            : change,
                    ),
                };
            return plan;
        });
        try {
            await expect(runBackupQualification(store(), 'local')).rejects.toThrow('Backup qualification:');
        } finally {
            planSpy.mockRestore();
            previewSpy.mockRestore();
        }
    },
    30_000,
);
