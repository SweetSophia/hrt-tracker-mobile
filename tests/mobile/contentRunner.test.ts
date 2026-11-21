import { expect, it } from 'vitest';
import { parseContentReports } from '../../scripts/mobile/run-native-content.mjs';

const names = ['passwordEntropyIsText', 'opsecDiagramsEnglish', 'opsecDiagramsChinese', 'malformedImportStaysPrivate'];
const booleans = ['snapshotUnchanged', 'bridgeAvailable', 'privilegedOriginUnchanged'] as const;
type ContentReport = {
    test: string;
    outcome: string;
    snapshotUnchanged?: boolean;
    bridgeAvailable?: boolean;
    privilegedOriginUnchanged?: boolean;
};
const reports = (): ContentReport[] =>
    names.map(test => ({
        test,
        outcome: 'pass',
        snapshotUnchanged: true,
        bridgeAvailable: true,
        privilegedOriginUnchanged: true,
    }));
const output = (cases = names, values: ContentReport[] = reports()) =>
    values
        .map(
            value =>
                'INSTRUMENTATION_STATUS: content_report=' +
                JSON.stringify(value) +
                '\nINSTRUMENTATION_STATUS_CODE: 2\n',
        )
        .join('') +
    cases
        .map(
            name =>
                'INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.ContentBoundaryTest\nINSTRUMENTATION_STATUS: test=' +
                name +
                '\nINSTRUMENTATION_STATUS: numtests=' +
                cases.length +
                '\nINSTRUMENTATION_STATUS_CODE: 0\n',
        )
        .join('') +
    'OK (' +
    cases.length +
    ' tests)\nINSTRUMENTATION_CODE: -1\n';

it('accepts only the four completed content-boundary cases and their reports', () => {
    const parsed = parseContentReports(output());
    expect(parsed.cases.map(item => item.name)).toEqual(names);
    expect(parsed.reports).toEqual(reports());
});

it('rejects missing, extra, duplicate, and wrong-class JUnit cases', () => {
    for (const cases of [names.slice(1), [...names, 'extra'], [names[0], names[0], names[2], names[3]]])
        expect(() => parseContentReports(output(cases))).toThrow();
    expect(() =>
        parseContentReports(output().replaceAll('storage.ContentBoundaryTest', 'storage.OtherTest')),
    ).toThrow();
});

it('rejects missing, duplicate, failing, incomplete, and malformed reports', () => {
    expect(() => parseContentReports(output(names, reports().slice(1)))).toThrow();
    const duplicated = reports();
    duplicated[3] = duplicated[0];
    expect(() => parseContentReports(output(names, duplicated))).toThrow();
    const extra = [...reports(), { ...reports()[0], test: 'unrelated' }];
    expect(() => parseContentReports(output(names, extra))).toThrow();
    const failed = reports();
    failed[2].outcome = 'fail';
    expect(() => parseContentReports(output(names, failed))).toThrow();
    for (const name of names) {
        for (const key of booleans) {
            const absent = reports();
            delete absent[names.indexOf(name)][key];
            expect(() => parseContentReports(output(names, absent)), name + ' missing ' + key).toThrow();
            const wrong = reports();
            wrong[names.indexOf(name)][key] = false;
            expect(() => parseContentReports(output(names, wrong)), name + ' false ' + key).toThrow();
        }
    }
    expect(() => parseContentReports(output().replace('content_report={', 'content_report={not-json'))).toThrow();
    expect(() => parseContentReports(output(names, []))).toThrow();
});

it('rejects incomplete or failed instrumentation even when report names match', () => {
    expect(() => parseContentReports(output().replace('OK (4 tests)', 'FAILURES!!!'))).toThrow();
    expect(() =>
        parseContentReports(output().replace('INSTRUMENTATION_STATUS_CODE: 0', 'INSTRUMENTATION_STATUS_CODE: -2')),
    ).toThrow();
    expect(() =>
        parseContentReports(output().replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0')),
    ).toThrow();
    expect(() => parseContentReports(output() + output())).toThrow();
});
