import { expect, it } from 'vitest';
import { parseBackReports } from '../../scripts/mobile/run-native-back-navigation.mjs';
const names = [
    'rootBackgroundResumeAndRecreation',
    'settingsBackUsesOwnedHistory',
    'promptInputAndKeyboardConsumeBeforeForm',
    'wizardBackStepsThenCancels',
];
const output = (cases = names, reports = names.map(test => ({ test, outcome: 'pass', snapshotUnchanged: true }))) =>
    reports
        .map(r => `INSTRUMENTATION_STATUS: back_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\n`)
        .join('') +
    cases
        .map(
            name =>
                `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.BackNavigationTest\nINSTRUMENTATION_STATUS: test=${name}\nINSTRUMENTATION_STATUS: numtests=${cases.length}\nINSTRUMENTATION_STATUS_CODE: 0\n`,
        )
        .join('') +
    `OK (${cases.length} tests)\nINSTRUMENTATION_CODE: -1\n`;
it('accepts only the complete native Back case inventory and unchanged snapshots', () => {
    expect(parseBackReports(output()).cases).toHaveLength(4);
    for (const cases of [names.slice(1), [...names, 'extra'], [names[0], names[0], names[2], names[3]]])
        expect(() => parseBackReports(output(cases))).toThrow();
    expect(() => parseBackReports(output(names, []))).toThrow();
    expect(() => parseBackReports(output().replace('"snapshotUnchanged":true', '"snapshotUnchanged":false'))).toThrow();
    expect(() => parseBackReports(output().replace('OK (4 tests)', 'FAILURES!!!'))).toThrow();
    expect(() => parseBackReports(output().replaceAll('storage.BackNavigationTest', 'storage.OtherTest'))).toThrow();
});
