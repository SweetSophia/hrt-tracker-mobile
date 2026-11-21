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

const CLASS = 'org.askarys.hrttracker.network.StartupNetworkTest';
const RUNNER = 'org.askarys.hrttracker.network.NetworkTestRunner';
const PHASES = ['freshStartup', 'seedDormantCredentials', 'restartDormantCredentials', 'observerControls'];
const DOCUMENTS = [1, 1, 2, 1];
const FLAGS = ['earlyObserver', 'online', 'localOrigin', 'noServiceWorker', 'ordinaryPluginsOnly'];
const CHANNELS = ['beacon', 'csp', 'fetch', 'resource', 'websocket', 'xhr'];

export function parseStartupPhase(output, phase) {
    if (!PHASES.includes(phase)) throw new Error('Unknown startup phase');
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== phase)
        throw new Error('Missing or unexpected startup JUnit case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: startup_report=(.*)$/gm)].map(match =>
        JSON.parse(match[1]),
    );
    const report = reports[0];
    const seeded = phase === 'seedDormantCredentials' || phase === 'restartDormantCredentials';
    const channels = report?.controlChannels;
    if (
        reports.length !== 1 ||
        report.phase !== phase ||
        report.outcome !== 'pass' ||
        !Number.isSafeInteger(report.pid) ||
        report.pid <= 0 ||
        FLAGS.some(flag => report[flag] !== true) ||
        report.automaticAttempts !== 0 ||
        report.observedDocuments !== DOCUMENTS[PHASES.indexOf(phase)] ||
        (seeded && (typeof report.fixtureSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.fixtureSha256))) ||
        (phase === 'observerControls' &&
            (!Array.isArray(channels) ||
                channels.length !== CHANNELS.length ||
                JSON.stringify([...channels].sort()) !== JSON.stringify(CHANNELS)))
    )
        throw new Error('Incomplete startup phase evidence');
    return { phase, cases, report };
}

export function validateStartupRun(runs) {
    if (JSON.stringify(runs.map(run => run.phase)) !== JSON.stringify(PHASES))
        throw new Error('Incomplete or reordered startup phases');
    const seed = runs[1],
        restart = runs[2];
    if (
        restart.forcedStopBefore !== true ||
        restart.processGoneBefore !== true ||
        seed.report.pid === restart.report.pid ||
        seed.report.fixtureSha256 !== restart.report.fixtureSha256
    )
        throw new Error('Missing restart or changed fixture');
    return runs;
}

async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const adb = (...args) => runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), 240_000);
    const report = { serial: values.serial, outcome: 'fail', phases: [] };
    const app = 'org.askarys.hrttracker.spike.networkqualification';
    let output = '',
        started = false;
    try {
        if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
        report.avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
        report.pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
        validateQualificationEnvironment(report.avd, report.pageSize);
        report.api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim());
        if (!Number.isSafeInteger(report.api) || report.api < 35)
            throw new Error('Startup network qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        report.apks = [];
        for (const relative of [
            'networkQualification/app-networkQualification.apk',
            'androidTest/networkQualification/app-networkQualification-androidTest.apk',
        ]) {
            const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${relative}`, import.meta.url));
            report.apks.push({ path: relative, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
            if (!(await adb('install', '-r', path)).includes('Success'))
                throw new Error('Qualification APK install failed');
        }
        started = true;
        const cleared = await adb('shell', 'pm', 'clear', app);
        output += `--- clear ${app} ---\n${cleared}\n`;
        if (!cleared.includes('Success')) throw new Error('Network qualification data clear failed');
        for (const phase of PHASES) {
            const restarting = phase === 'restartDormantCredentials';
            if (restarting) {
                const stopped = await adb('shell', 'am', 'force-stop', app);
                let pid;
                try {
                    pid = await adb('shell', 'pidof', app);
                } catch (error) {
                    if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw error;
                    pid = '';
                }
                if (pid.trim()) throw new Error('App process remains after force-stop');
                output += `--- ${phase} force-stop ---\n${stopped}\n--- ${phase} pidof ---\n${pid}\n`;
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
                `${app}.test/${RUNNER}`,
            );
            output += `--- ${phase} ---\n${result}\n`;
            report.phases.push({
                ...parseStartupPhase(result, phase),
                forcedStopBefore: restarting,
                processGoneBefore: restarting,
            });
        }
        validateStartupRun(report.phases);
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="startup-network ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="4" failures="0" skipped="0">\n` +
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
