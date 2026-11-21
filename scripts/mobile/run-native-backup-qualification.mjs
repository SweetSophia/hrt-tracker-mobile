import { execFile, spawn } from 'node:child_process';
import { reserveEvidence } from './backup-evidence.mjs';
import expectedChecks from '../../tests/fixtures/mobile/backups/checks-v1.json' with { type: 'json' };
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    qualificationAdbArgs,
    validateQualificationEnvironment,
    instrumentationCases,
} from './run-native-storage-qualification.mjs';

export function parseBackupReport(output) {
    const matches = [...output.matchAll(/^INSTRUMENTATION_STATUS: backup_report=(.*)$/gm)];
    if (matches.length !== 1) throw new Error('Exactly one backup report is required');
    const report = JSON.parse(matches[0][1]);
    if (report.outcome !== 'pass') throw new Error('Backup qualification failed');
    return report;
}
export function assertRecovery(seed, recovered, acknowledged) {
    if (seed.replacementSemanticsVerified !== true || seed.before === seed.after)
        throw new Error('Replacement semantics were not independently checked');
    for (const value of [seed.before, seed.after, recovered.digest])
        if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
            throw new Error('Missing complete snapshot digest');
    if (!(acknowledged ? [seed.after] : [seed.before, seed.after]).includes(recovered.digest))
        throw new Error('Recovered backup is not the expected complete generation');
}
export function assertCompatibilityReport(report) {
    const checks = report.checks;
    if (
        !checks ||
        typeof checks !== 'object' ||
        Array.isArray(checks) ||
        JSON.stringify(Object.keys(checks).sort()) !== JSON.stringify([...expectedChecks].sort()) ||
        Object.values(checks).some(value => value !== true)
    )
        throw new Error('Incomplete or invalid compatibility checks');
}
async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    try {
        await qualify(values, evidence);
    } finally {
        evidence.close();
    }
}
async function qualify(values, evidence) {
    const exec = promisify(execFile);
    const adb = async (...args) =>
        (
            await exec('adb', qualificationAdbArgs(values.serial, args), {
                encoding: 'utf8',
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
            })
        ).stdout;
    if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
    const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
    const pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
    validateQualificationEnvironment(avd, pageSize);
    const app = 'org.askarys.hrttracker.spike.storagequalification';
    for (const apk of [
        'storageQualification/app-storageQualification.apk',
        'androidTest/storageQualification/app-storageQualification-androidTest.apk',
    ]) {
        const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${apk}`, import.meta.url));
        if (!(await adb('install', '-r', path)).includes('Success'))
            throw new Error('Qualification APK install failed');
    }
    const report = {
        avd,
        serial: values.serial,
        pageSize,
        api: (await adb('shell', 'getprop', 'ro.build.version.sdk')).trim(),
        cases: [],
        owners: {},
    };
    const logs = [];
    const command = (method, phase, owner) => [
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'class',
        `org.askarys.hrttracker.storage.BackupBridgeTest#${method}`,
        ...(phase ? ['-e', 'phase', phase, '-e', 'owner', owner] : []),
        `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
    ];
    const checked = async (label, args) => {
        const output = await adb(...args);
        logs.push(`=== ${label} ===\n${output}`);
        report.cases.push(...instrumentationCases(output).map(item => ({ ...item, name: `${label}: ${item.name}` })));
        return output;
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function stopAt(owner, phase) {
        // A prior incomplete transaction must be recovered before observing the new boundary.
        try {
            const size = await adb(
                'shell',
                'run-as',
                app,
                'stat',
                '-c',
                '%s',
                'no_backup/native-records/primary-v1/records.db-journal',
            );
            if (Number(size.trim()) > 0) throw new Error('A journal already exists before the new restore');
        } catch (error) {
            if (!String(error.message).includes('No such file')) throw error;
        }
        let output = '',
            done = false,
            processError;
        const child = spawn('adb', qualificationAdbArgs(values.serial, command('phase', phase, owner)), {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', data => {
            output += data;
        });
        child.stderr.on('data', data => {
            output += data;
        });
        child.on('error', error => {
            processError = error;
            done = true;
        });
        const exited = new Promise(resolve =>
            child.on('close', () => {
                done = true;
                resolve();
            }),
        );
        let observed = false,
            journalBytes = 0;
        try {
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline && !done) {
                if (phase === 'ack' && output.includes('backup_commit=acknowledged')) {
                    observed = true;
                    break;
                }
                if (phase === 'interrupt' && output.includes('backup_commit=starting')) {
                    if (output.includes('backup_commit=acknowledged'))
                        throw new Error('Restore completed before interruption');
                    try {
                        journalBytes = Number(
                            (
                                await adb(
                                    'shell',
                                    'run-as',
                                    app,
                                    'stat',
                                    '-c',
                                    '%s',
                                    'no_backup/native-records/primary-v1/records.db-journal',
                                )
                            ).trim(),
                        );
                    } catch {
                        /* Transaction has not spilled yet. */
                    }
                    if (journalBytes > 0) {
                        observed = true;
                        break;
                    }
                }
                await pause(20);
            }
            if (!observed) throw processError ?? new Error('Requested restore boundary was not observed');
            await adb('shell', 'am', 'force-stop', app);
            await Promise.race([exited, pause(5_000)]);
            if (!done) throw new Error('Instrumentation process did not stop');
            if (/FAILURES|INSTRUMENTATION_FAILED/.test(output) && !/Process crashed/.test(output))
                throw new Error('Phase failed before forced stop');
            return {
                boundary: phase === 'ack' ? 'durable acknowledgement' : 'nonempty rollback journal',
                journalBytes,
                acknowledged: output.includes('backup_commit=acknowledged'),
            };
        } finally {
            if (!done) {
                await adb('shell', 'am', 'force-stop', app);
                child.kill();
            }
            logs.push(`=== ${owner} ${phase} (deliberately killed; not a passed JUnit case) ===\n${output}`);
        }
    }
    try {
        for (const [owner, method] of [
            ['local', 'anonymous'],
            ['synthetic-account', 'account'],
        ]) {
            const compatibility = parseBackupReport(
                await checked(`${owner} compatibility`, command(`${method}BackupInteroperability`)),
            );
            assertCompatibilityReport(compatibility);
            await checked(`${owner} injected failure`, command(`${method}FailedRestoreRollsBackEveryEntry`));
            const attempts = [];
            for (const phase of ['interrupt', 'ack']) {
                const seed = parseBackupReport(
                    await checked(`${owner} ${phase} seed`, command('phase', 'seed', owner)),
                );
                const boundary = await stopAt(owner, phase);
                const recovered = parseBackupReport(
                    await checked(`${owner} ${phase} reopened`, command('phase', 'verify', owner)),
                );
                assertRecovery(seed, recovered, phase === 'ack');
                attempts.push({ phase, seed, boundary, recovered });
            }
            report.owners[owner] = { compatibility, attempts };
        }
        report.cleanup = parseBackupReport(
            await checked('synthetic credential cleanup', command('phase', 'cleanup', 'local')),
        );
        if (report.cleanup.checks?.syntheticSecretsRemoved !== true) throw new Error('Missing cleanup evidence');
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="native-backup ${escape(avd)} ${escape(values.serial)} ${pageSize}-byte-page" tests="${report.cases.length}" failures="0" skipped="0">\n` +
                report.cases
                    .map(item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`)
                    .join('\n') +
                '\n</testsuite>\n',
        );
        report.outcome = 'pass';
    } catch (error) {
        report.outcome = 'fail';
        report.error = String(error.message);
        throw error;
    } finally {
        evidence.write('log', logs.join('\n'));
        evidence.write('json', JSON.stringify(report, null, 2) + '\n');
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}
