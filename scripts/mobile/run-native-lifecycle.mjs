import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import { runInterruptionCommand } from './screen-interruption.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const CLASS = 'org.askarys.hrttracker.storage.LifecycleParityTest';
const FLAGS = {
    draftLifecycle: ['backgroundDraftRetained', 'rotationDraftRetained', 'recreationNoReplay', 'unchanged'],
    acknowledgedEditsSeed: [
        'bothModesSaved',
        'scopeIsolated',
        'acknowledged',
        'backgroundUnchanged',
        'recreationUnchanged',
    ],
    acknowledgedEditsVerify: ['reopenedExact', 'noReplay', 'bothModesExact'],
};
const PHASES = Object.keys(FLAGS);
export function parseLifecyclePhase(output, phase) {
    if (!PHASES.includes(phase)) throw new Error('Unknown lifecycle phase');
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== phase)
        throw new Error('Missing or unexpected lifecycle JUnit case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: lifecycle_report=(.*)$/gm)].map(match =>
        JSON.parse(match[1]),
    );
    const report = reports[0];
    if (
        reports.length !== 1 ||
        report?.phase !== phase ||
        report.outcome !== 'pass' ||
        !Number.isSafeInteger(report.pid) ||
        report.pid <= 0 ||
        typeof report.snapshotSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(report.snapshotSha256) ||
        FLAGS[phase].some(flag => report[flag] !== true)
    )
        throw new Error('Incomplete lifecycle phase evidence');
    return { phase, cases, report };
}
export function validateLifecycleRun(runs) {
    if (JSON.stringify(runs.map(run => run.phase)) !== JSON.stringify(PHASES))
        throw new Error('Incomplete or reordered lifecycle phases');
    const before = runs[1],
        after = runs[2];
    if (
        after.forcedStopBefore !== true ||
        after.processGoneBefore !== true ||
        before.report.pid === after.report.pid ||
        before.report.snapshotSha256 !== after.report.snapshotSha256
    )
        throw new Error('Missing restart or changed durable state');
    return runs;
}

async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const adb = (...args) => runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), 240_000);
    const report = { serial: values.serial, outcome: 'fail', phases: [] };
    const app = 'org.askarys.hrttracker.spike.storagequalification';
    let output = '',
        started = false;
    try {
        if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
        report.avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
        report.pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
        validateQualificationEnvironment(report.avd, report.pageSize);
        report.api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim());
        if (!Number.isSafeInteger(report.api) || report.api < 35)
            throw new Error('Lifecycle qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        report.apks = [];
        for (const relative of [
            'storageQualification/app-storageQualification.apk',
            'androidTest/storageQualification/app-storageQualification-androidTest.apk',
        ]) {
            const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${relative}`, import.meta.url));
            report.apks.push({ path: relative, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
            if (!(await adb('install', '-r', path)).includes('Success'))
                throw new Error('Qualification APK install failed');
        }
        started = true;
        for (const phase of PHASES) {
            const verifying = phase === 'acknowledgedEditsVerify',
                args = [];
            if (verifying) {
                await adb('shell', 'am', 'force-stop', app);
                let pid;
                try {
                    pid = await adb('shell', 'pidof', app);
                } catch (error) {
                    if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw error;
                    pid = '';
                }
                if (pid.trim()) throw new Error('App process remains after force-stop');
                args.push('-e', 'expectedDigest', report.phases.at(-1).report.snapshotSha256);
            }
            console.log(`Running ${phase} on ${values.serial}`);
            const result = await adb(
                'shell',
                'am',
                'instrument',
                '-w',
                '-r',
                '-e',
                'class',
                `${CLASS}#${phase}`,
                ...args,
                `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
            );
            output += `--- ${phase} ---\n${result}\n`;
            report.phases.push({
                ...parseLifecyclePhase(result, phase),
                forcedStopBefore: verifying,
                processGoneBefore: verifying,
            });
        }
        validateLifecycleRun(report.phases);
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="lifecycle ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="3" failures="0" skipped="0">\n` +
                report.phases
                    .flatMap(run =>
                        run.cases.map(
                            item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`,
                        ),
                    )
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
                await adb('shell', 'am', 'force-stop', app);
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
    console.log(JSON.stringify({ outcome: report.outcome, serial: report.serial, cases: report.phases.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
