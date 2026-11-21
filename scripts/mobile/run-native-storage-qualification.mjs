import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function qualificationAdbArgs(serial, args) {
    if (typeof serial !== 'string' || !/^emulator-\d+$/.test(serial)) {
        throw new Error('An explicit emulator serial is required; this runner does not operate physical phones');
    }
    return ['-s', serial, ...args];
}

export function validateQualificationEnvironment(avd, pageSize) {
    const expected = { HRT_Feasibility_API36: 4096, HRT_Feasibility_16KB: 16384 };
    if (!Object.hasOwn(expected, avd) || pageSize !== expected[avd]) {
        throw new Error('Selected AVD does not have its required measured page size');
    }
}

export function instrumentationCases(output) {
    const cases = [];
    const seen = new Set();
    let current = {};
    for (const line of output.split(/\r?\n/)) {
        const field = /^INSTRUMENTATION_STATUS: (class|test|numtests)=(.*)$/.exec(line);
        if (field) current[field[1]] = field[2];
        const status = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/.exec(line);
        if (!status) continue;
        if (!['0', '1', '2'].includes(status[1])) throw new Error('Instrumentation case failed or was skipped');
        if (status[1] === '0') {
            const key = `${current.class}#${current.test}`;
            if (!current.class || !current.test || seen.has(key) || !/^[1-9]\d*$/.test(current.numtests ?? '')) {
                throw new Error('Missing or duplicate instrumentation result');
            }
            seen.add(key);
            cases.push({ className: current.class, name: current.test });
        }
        current = {};
    }
    const summaries = [...output.matchAll(/^OK \((\d+) tests?\)$/gm)];
    if (
        summaries.length !== 1 ||
        cases.length === 0 ||
        Number(summaries[0][1]) !== cases.length ||
        !/^INSTRUMENTATION_CODE: -1\s*$/m.test(output) ||
        /FAILURES|INSTRUMENTATION_FAILED|Process crashed/.test(output)
    )
        throw new Error('Incomplete or failed instrumentation run');
    return cases;
}

async function main() {
    const { values } = parseArgs({
        options: {
            serial: { type: 'string' },
            output: { type: 'string' },
            reboot: { type: 'boolean', default: false },
            bridge: { type: 'boolean', default: false },
        },
    });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX [--reboot]');
    for (const suffix of ['.json', '.xml', '.log']) {
        if (existsSync(values.output + suffix)) throw new Error('Refusing to overwrite qualification evidence');
    }
    const run = promisify(execFile);
    const adb = async (...args) =>
        (
            await run('adb', qualificationAdbArgs(values.serial, args), {
                encoding: 'utf8',
                timeout: 120_000,
                maxBuffer: 8 * 1024 * 1024,
            })
        ).stdout;
    if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
    const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
    if (!['HRT_Feasibility_API36', 'HRT_Feasibility_16KB'].includes(avd))
        throw new Error('Only dedicated HRT test AVDs are allowed');
    const app = 'org.askarys.hrttracker.spike.storagequalification';
    const runner = `${app}.test/androidx.test.runner.AndroidJUnitRunner`;
    const prefix = 'org.askarys.hrttracker.storage.';
    const pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
    validateQualificationEnvironment(avd, pageSize);
    for (const apk of [
        'storageQualification/app-storageQualification.apk',
        'androidTest/storageQualification/app-storageQualification-androidTest.apk',
    ]) {
        const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${apk}`, import.meta.url));
        if (!(await adb('install', '-r', path)).includes('Success'))
            throw new Error('Qualification APK installation failed');
    }
    const log = [];
    const cases = [];
    const report = {
        avd,
        serial: values.serial,
        api: (await adb('shell', 'getprop', 'ro.build.version.sdk')).trim(),
        abi: (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim(),
        pageSize,
        sqlcipher: '4.17.0 community (asserted during every initialize)',
        acknowledgementKill: false,
        interruptedCommit: null,
        reboot: false,
        bridge: values.bridge,
    };
    const instrument = (className, extra = []) => [
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'class',
        className,
        ...extra,
        runner,
    ];
    const checked = async (label, args) => {
        const output = await adb(...args);
        log.push(`=== ${label} ===\n${output}`);
        const measured = instrumentationCases(output);
        cases.push(...measured.map(item => ({ ...item, name: `${label}: ${item.name}` })));
        return output;
    };
    const storeId = `lifecycle-${randomUUID()}`;
    const phase = name => instrument(`${prefix}LifecycleTest#phase`, ['-e', 'phase', name, '-e', 'storeId', storeId]);
    const bridgePhase = name =>
        instrument(`${prefix}BridgeLifecycleTest#phase`, ['-e', 'phase', name, '-e', 'storeId', storeId]);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    // A killed instrument run is not a passed JUnit case. It has a separate observed boundary and a verified reopen.
    async function killAt(name, marker, observeJournal, args = phase(name)) {
        const child = spawn('adb', qualificationAdbArgs(values.serial, args), {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '',
            done = false,
            processError;
        child.stdout.on('data', chunk => {
            output += chunk;
        });
        child.stderr.on('data', chunk => {
            output += chunk;
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
        const deadline = Date.now() + 30_000;
        let observed = false;
        try {
            while (Date.now() < deadline && !done) {
                if (output.includes(marker)) {
                    if (!observeJournal) {
                        observed = true;
                        break;
                    }
                    const path = `no_backup/native-records/${storeId}/records.db-journal`;
                    try {
                        // The fixed UUID path is generated here, never provided by a shell/user payload.
                        const size = await adb('shell', 'run-as', app, 'stat', '-c', '%s', path);
                        if (Number(size.trim()) > 0) {
                            observed = true;
                            break;
                        }
                    } catch {
                        /* A journal may not yet exist. Keep observing until the bounded deadline. */
                    }
                    if (output.includes('native_commit=completed'))
                        throw new Error('Commit finished before journal observation');
                }
                await pause(5);
            }
            if (!observed) throw processError ?? new Error('Kill boundary was not observed');
            const observedAt = Date.now();
            await adb('shell', 'am', 'force-stop', app);
            await Promise.race([exited, pause(5_000)]);
            if (!done) throw new Error('Instrument process did not stop');
            if (/FAILURES|INSTRUMENTATION_FAILED/.test(output) && !/Process crashed/.test(output))
                throw new Error('Phase failed before forced stop');
            return {
                boundary: observeJournal ? 'nonempty rollback journal observed' : 'durable acknowledgement observed',
                forceStopReturnedAfterMs: Date.now() - observedAt,
                completionSignalSeen: output.includes('native_commit=completed'),
            };
        } finally {
            if (!done) {
                await adb('shell', 'am', 'force-stop', app);
                child.kill();
            }
            log.push(`=== ${name} (deliberately killed; not a passed test) ===\n${output}`);
        }
    }
    try {
        await checked(
            'suite',
            instrument(
                ['SecretStoreTest', 'RecordStoreTest', 'BackupPolicyTest', 'PendingCleanupTest', 'RecoveryPolicyTest']
                    .map(name => prefix + name)
                    .join(','),
            ),
        );
        if (values.bridge) {
            await checked('bridge-suite', instrument(`${prefix}StorageBridgeTest`));
            report.bridgeAcknowledgementKill = await killAt(
                'bridge-ack',
                'bridge_ack=durable',
                false,
                bridgePhase('ack'),
            );
            await checked('bridge-reopen-after-ack', bridgePhase('verify'));
        }
        report.acknowledgementKill = await killAt('ack', 'native_ack=durable', false);
        await checked('reopen-after-ack', phase('verify'));
        report.interruptedCommit = await killAt('interrupt', 'native_commit=starting', true);
        const recovered = await checked('reopen-after-interruption', phase('recover'));
        report.recoveredRevision = Number(/recovered_revision=(\d+)/.exec(recovered)?.[1]);
        if (![1, 2].includes(report.recoveredRevision)) throw new Error('Missing recovery evidence');
        if (values.reboot) {
            await adb('reboot');
            const deadline = Date.now() + 90_000;
            let booted = false;
            while (Date.now() < deadline) {
                try {
                    booted = (await adb('shell', 'getprop', 'sys.boot_completed')).trim() === '1';
                } catch {
                    /* Explicitly selected emulator is rebooting. */
                }
                if (booted) break;
                await pause(500);
            }
            if (!booted) throw new Error('Selected emulator did not reboot in time');
            await checked('reopen-after-reboot', phase('recover'));
            if (values.bridge) await checked('bridge-reopen-after-reboot', bridgePhase('verify'));
            report.reboot = true;
        }
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        const xml =
            `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="native-storage" tests="${cases.length}" failures="0" skipped="0">\n` +
            cases
                .map(item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`)
                .join('\n') +
            '\n</testsuite>\n';
        writeFileSync(values.output + '.xml', xml, { flag: 'wx' });
        report.completedTests = cases.length;
        report.outcome = 'pass';
        report.unverified = [
            'physical ARM64',
            'real power loss',
            'physical disk exhaustion',
            'OEM backup/transfer',
            ...(values.bridge ? [] : ['Capacitor/React integration']),
        ];
        writeFileSync(values.output + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        writeFileSync(values.output + '.log', log.join('\n'), { flag: 'wx' });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        process.stderr.write(`${error.stack}\n`);
        process.exitCode = 1;
    });
}
