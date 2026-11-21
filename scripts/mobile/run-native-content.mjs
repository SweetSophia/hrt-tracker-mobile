import { runInterruptionCommand } from './screen-interruption.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const CLASS = 'org.askarys.hrttracker.storage.ContentBoundaryTest';
const NAMES = ['passwordEntropyIsText', 'opsecDiagramsEnglish', 'opsecDiagramsChinese', 'malformedImportStaysPrivate'];
const exactNames = values => JSON.stringify([...values].sort()) === JSON.stringify([...NAMES].sort());

export function parseContentReports(output) {
    const cases = instrumentationCases(output);
    if (!exactNames(cases.map(item => item.name)) || cases.some(item => item.className !== CLASS))
        throw new Error('Missing, extra or unknown Android content cases');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: content_report=(.*)$/gm)].map(match =>
        JSON.parse(match[1]),
    );
    if (
        !exactNames(reports.map(item => item?.test)) ||
        reports.some(
            item =>
                item.outcome !== 'pass' ||
                item.snapshotUnchanged !== true ||
                item.bridgeAvailable !== true ||
                item.privilegedOriginUnchanged !== true,
        )
    )
        throw new Error('Missing or invalid Android content reports');
    return { cases, reports };
}

async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const adb = (...args) => runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), 240_000);
    const report = { serial: values.serial, outcome: 'fail' };
    let output = '',
        started = false;
    const app = 'org.askarys.hrttracker.spike.storagequalification';
    try {
        if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
        report.avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
        report.pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
        validateQualificationEnvironment(report.avd, report.pageSize);
        report.api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim());
        if (!Number.isSafeInteger(report.api) || report.api < 35)
            throw new Error('Content boundary qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        report.apks = [];
        for (const apk of [
            'storageQualification/app-storageQualification.apk',
            'androidTest/storageQualification/app-storageQualification-androidTest.apk',
        ]) {
            const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${apk}`, import.meta.url));
            report.apks.push({ path: apk, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
            if (!(await adb('install', '-r', path)).includes('Success'))
                throw new Error('Qualification APK install failed');
        }
        started = true;
        output = await adb(
            'shell',
            'am',
            'instrument',
            '-w',
            '-r',
            '-e',
            'class',
            CLASS,
            `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
        );
        Object.assign(report, parseContentReports(output));
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="android-content ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="4" failures="0" skipped="0">\n` +
                report.cases
                    .map(item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`)
                    .join('\n') +
                '\n</testsuite>\n',
        );
        report.outcome = 'pass';
    } catch (error) {
        report.error = String(error.message);
        if (error.stdout) output += error.stdout;
        if (error.stderr) output += error.stderr;
        if (started) {
            try {
                await runInterruptionCommand(
                    'adb',
                    qualificationAdbArgs(values.serial, ['shell', 'am', 'force-stop', app]),
                );
            } catch {
                report.stopFailed = true;
            }
        }
        throw error;
    } finally {
        try {
            evidence.write('log', output);
            evidence.write('json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            evidence.close();
        }
    }
    process.stdout.write(
        JSON.stringify({ outcome: report.outcome, serial: values.serial, cases: report.cases.length }) + '\n',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}
