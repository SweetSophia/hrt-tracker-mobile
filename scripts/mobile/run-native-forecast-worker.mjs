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

const CLASS = 'org.askarys.hrttracker.storage.ForecastEngineWorkerTest';
const CHECKS = [
    'ordinaryForecast',
    'sharedWorker',
    'rendererProgress',
    'exactBatch',
    'draftsRetained',
    'failureVisible',
    'retrySucceeded',
    'recordsUnchanged',
];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parseForecastWorkerReport(output) {
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== 'ordinaryForecast')
        throw new Error('Missing or unexpected forecast-worker case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: forecast_worker_report=(.*)$/gm)].map(m =>
        JSON.parse(m[1]),
    );
    const r = reports[0],
        m = r?.metrics,
        c = r?.checks;
    if (
        reports.length !== 1 ||
        r.outcome !== 'pass' ||
        r.snapshotUnchanged !== true ||
        r.localOrigin !== true ||
        !digest(r.beforeHash) ||
        r.beforeHash !== r.afterHash ||
        !c ||
        Object.keys(c).length !== CHECKS.length ||
        CHECKS.some(k => c[k] !== true) ||
        !m ||
        !Number.isSafeInteger(m.ticks) ||
        m.ticks <= 0 ||
        !Number.isFinite(m.maxGapMs) ||
        m.maxGapMs < 0 ||
        !Number.isFinite(m.roundTripMs) ||
        m.roundTripMs <= 0 ||
        !Number.isSafeInteger(m.requests) ||
        m.requests < 2 ||
        !Number.isSafeInteger(m.results) ||
        m.results < 2 ||
        !Number.isSafeInteger(m.mcmcResults) ||
        m.mcmcResults < 1
    )
        throw new Error('Incomplete forecast-worker evidence');
    return { cases, reports };
}

async function main() {
    const { values } = parseArgs({
        options: { serial: { type: 'string' }, output: { type: 'string' }, 'negative-control': { type: 'string' } },
    });
    qualificationAdbArgs(values.serial, []);
    if (values['negative-control'] && values['negative-control'] !== 'heartbeat')
        throw new Error('Unknown worker negative control');
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const adb = (...args) => runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), 240_000);
    const report = { serial: values.serial, outcome: 'fail', negativeControl: values['negative-control'] ?? null };
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
            throw new Error('Forecast-worker qualification requires API 35+');
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
            ...(values['negative-control'] ? ['-e', 'negativeControl', values['negative-control']] : []),
            `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
        );
        Object.assign(report, parseForecastWorkerReport(output));
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="android-forecast-worker ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="1" failures="0" skipped="0">\n` +
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
