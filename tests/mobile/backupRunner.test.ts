import { expect, it } from 'vitest';
import {
    parseBackupReport,
    assertRecovery,
    assertCompatibilityReport,
} from '../../scripts/mobile/run-native-backup-qualification.mjs';

import expectedChecks from '../fixtures/mobile/backups/checks-v1.json';

const hash = 'a'.repeat(64),
    next = 'b'.repeat(64);
it('rejects absent, duplicate and failed backup reports', () => {
    for (const text of [
        '',
        'INSTRUMENTATION_STATUS: backup_report={"outcome":"fail"}',
        'INSTRUMENTATION_STATUS: backup_report={}\nINSTRUMENTATION_STATUS: backup_report={}',
    ]) {
        expect(() => parseBackupReport(text)).toThrow();
    }
    expect(
        parseBackupReport('INSTRUMENTATION_STATUS: backup_report={"outcome":"pass","digest":"' + hash + '"}').digest,
    ).toBe(hash);
});
it('accepts only complete old/new generations and requires the acknowledged generation', () => {
    for (const digest of [hash, next])
        expect(() =>
            assertRecovery({ before: hash, after: next, replacementSemanticsVerified: true }, { digest }, false),
        ).not.toThrow();
    expect(() =>
        assertRecovery({ before: hash, after: next, replacementSemanticsVerified: true }, { digest: next }, true),
    ).not.toThrow();
    for (const digest of [undefined, '', 'c'.repeat(64)])
        expect(() =>
            assertRecovery({ before: hash, after: next, replacementSemanticsVerified: true }, { digest }, false),
        ).toThrow();
    expect(() =>
        assertRecovery({ before: hash, after: next, replacementSemanticsVerified: true }, { digest: hash }, true),
    ).toThrow();
    expect(() => assertRecovery({}, {}, false)).toThrow();
    expect(() => assertRecovery({ before: hash, after: next }, { digest: hash }, false)).toThrow();
    expect(() =>
        assertRecovery({ before: hash, after: hash, replacementSemanticsVerified: true }, { digest: hash }, false),
    ).toThrow();
});

it('requires every named check and rejects malformed cross-process reports', () => {
    const checks = Object.fromEntries(expectedChecks.map(name => [name, true]));
    expect(() => assertCompatibilityReport({ checks })).not.toThrow();
    for (const variant of [undefined, [], {}, { ...checks, unexpected: true }, { ...checks, webToNativeExact: false }])
        expect(() => assertCompatibilityReport({ checks: variant })).toThrow();
    const renamed: Record<string, boolean> = { ...checks, wrongCheck: true };
    delete renamed.webToNativeExact;
    expect(() => assertCompatibilityReport({ checks: renamed })).toThrow();
});
