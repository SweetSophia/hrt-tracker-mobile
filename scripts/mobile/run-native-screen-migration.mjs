import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import { interruptPendingPreview, runInterruptionCommand } from './screen-interruption.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const CLASS = 'org.askarys.hrttracker.storage.ScreenMigrationTest';
export const SCREEN_PHASES = [
    'screenJourneys',
    'confirmedRestartSeed',
    'confirmedRestartVerify',
    'pendingRestartSeed',
    'pendingRestartVerify',
];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const flags = {
    screenJourneys: [
        'previewNoWrite',
        'pdfTextVerified',
        'csvRowsVerified',
        'wrongPasswordUnchanged',
        'mergeCancelledUnchanged',
        'bothModesMerged',
        'completeExportExact',
        'cancelledSaveAbsent',
        'encryptedSaved',
        'replaceCancelledUnchanged',
        'bothModesReplaced',
        'passwordCancelledUnchanged',
        'encryptedImportExact',
        'pickerCancelledUnchanged',
        'retrySucceeded',
    ],
    confirmedRestartSeed: ['acknowledged'],
    confirmedRestartVerify: ['reopenedExact', 'noReplay', 'exportExact'],
    pendingRestartSeed: ['previewOpen', 'unchanged'],
    pendingRestartVerify: ['reopenedExact', 'noReplay', 'exportExact'],
};

export function parseScreenPhase(output, phase) {
    if (!SCREEN_PHASES.includes(phase) || phase === 'pendingRestartSeed')
        throw new Error('Expected a completed screen phase, not an interrupted seed');
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== phase)
        throw new Error('Missing or unexpected screen JUnit case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: screen_report=(.*)$/gm)].map(match =>
        JSON.parse(match[1]),
    );
    const report = reports[0];
    if (
        reports.length !== 1 ||
        report?.phase !== phase ||
        report.outcome !== 'pass' ||
        report.cleaned !== true ||
        !Number.isSafeInteger(report.pid) ||
        report.pid <= 0 ||
        !digest(report.snapshotSha256) ||
        flags[phase].some(flag => report[flag] !== true)
    )
        throw new Error('Incomplete screen phase evidence');
    if (phase === 'screenJourneys') {
        if (report.jsonRows !== 2 || ['csvSha256', 'pdfSha256', 'icsSha256'].some(key => !digest(report[key])))
            throw new Error('Missing shared screen exports');
        const png = report.previewPng;
        if (typeof png !== 'string' || png.length > 600_000) throw new Error('Missing or oversized screen image');
        const bytes = Buffer.from(png, 'base64');
        if (
            bytes.length < 45 ||
            bytes.toString('base64') !== png ||
            bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
            bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
        )
            throw new Error('Malformed screen image');
    }
    return { phase, cases, report };
}

export function validateScreenRun(runs) {
    if (JSON.stringify(runs.map(run => run.phase)) !== JSON.stringify(SCREEN_PHASES))
        throw new Error('Incomplete or reordered screen phase sequence');
    const pending = runs[3];
    if (
        pending.cases.length !== 0 ||
        pending.report.outcome !== 'waiting' ||
        pending.interruption?.livePid !== pending.report.pid ||
        pending.interruption?.forceStopReturned !== true ||
        pending.interruption?.processGone !== true
    )
        throw new Error('Missing live pending-preview interruption evidence');
    for (const index of [2, 4]) {
        const before = runs[index - 1].report,
            after = runs[index].report;
        if (
            runs[index].forcedStopBefore !== true ||
            before.pid === after.pid ||
            before.snapshotSha256 !== after.snapshotSha256
        )
            throw new Error('Missing process restart or changed durable snapshot');
    }
    return runs;
}

async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const exec = promisify(execFile);
    const adb = async (...args) =>
        (
            await exec('adb', qualificationAdbArgs(values.serial, args), {
                encoding: 'utf8',
                timeout: 360_000,
                maxBuffer: 8 * 1024 * 1024,
            })
        ).stdout;
    const interruptionAdb = (...args) => runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args));
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
            throw new Error('Screen PDF text checks require API 35+');
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
        for (const phase of SCREEN_PHASES) {
            const args = [];
            const verifying = phase.endsWith('Verify');
            if (verifying) {
                await adb('shell', 'am', 'force-stop', app);
                args.push('-e', 'expectedDigest', report.phases.at(-1).report.snapshotSha256);
            }
            console.log(`Running ${phase} on ${values.serial}`);
            const command = [
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
            ];
            if (phase === 'pendingRestartSeed') {
                const child = spawn('adb', qualificationAdbArgs(values.serial, command), {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                const { output: text, ...interrupted } = await interruptPendingPreview(child, {
                    getPid: async () => {
                        try {
                            return await interruptionAdb('shell', 'pidof', app);
                        } catch (error) {
                            if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return '';
                            throw error;
                        }
                    },
                    stop: () => interruptionAdb('shell', 'am', 'force-stop', app),
                });
                output += `--- ${phase} (deliberately interrupted, not a passed JUnit case) ---\n${text}\n`;
                report.phases.push(interrupted);
                continue;
            }
            const text = await adb(...command);
            output += `--- ${phase} ---\n${text}\n`;
            report.phases.push({ ...parseScreenPhase(text, phase), forcedStopBefore: verifying });
        }
        validateScreenRun(report.phases);
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="screen-migration ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="4" failures="0" skipped="0">\n` +
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
        if (error.instrumentationOutput) output += error.instrumentationOutput;
        if (error.stdout) output += error.stdout;
        if (error.stderr) output += error.stderr;
        if (started) {
            try {
                await interruptionAdb('shell', 'am', 'force-stop', app);
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
    console.log(
        JSON.stringify({
            outcome: report.outcome,
            serial: report.serial,
            completedJUnit: 4,
            interruptedSeeds: 1,
            restarts: 2,
        }),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
