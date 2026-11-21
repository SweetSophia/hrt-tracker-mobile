import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import { runInterruptionCommand } from './screen-interruption.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const APP = 'org.askarys.hrttracker.spike.upgradequalification';
const CLASS = 'org.askarys.hrttracker.network.OfflineUpgradeTest';
const RUNNER = 'org.askarys.hrttracker.network.NetworkTestRunner';
const PHASES = ['offlineFirstLaunch', 'seedUpgradeState', 'upgradedOffline', 'upgradedOnline'];
const FLAGS = ['earlyObserver', 'localOrigin', 'noServiceWorker', 'ordinaryPluginsOnly'];
const HEX = /^[a-f0-9]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;

export function parseUpgradePhase(output, phase) {
    const index = PHASES.indexOf(phase);
    if (index < 0) throw new Error('Unknown upgrade phase');
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== phase)
        throw new Error('Missing or unexpected upgrade JUnit case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: upgrade_report=(.*)$/gm)].map(m => JSON.parse(m[1]));
    const r = reports[0];
    if (
        reports.length !== 1 ||
        r.phase !== phase ||
        r.outcome !== 'pass' ||
        !['pid', 'uid', 'firstInstallTime', 'lastUpdateTime'].every(key => positive(r[key])) ||
        r.lastUpdateTime < r.firstInstallTime ||
        typeof r.signerSha256 !== 'string' ||
        !HEX.test(r.signerSha256) ||
        r.versionCode !== (index < 2 ? 1 : 2) ||
        r.canaryVersion !== r.versionCode ||
        r.online !== (index % 2 === 1) ||
        typeof r.webViewOnline !== 'boolean' ||
        FLAGS.some(key => r[key] !== true) ||
        r.automaticAttempts !== 0 ||
        r.observedDocuments !== (index === 3 ? 2 : 1) ||
        (index > 0 &&
            (typeof r.fixtureSha256 !== 'string' ||
                !HEX.test(r.fixtureSha256) ||
                typeof r.cacheSentinelPresent !== 'boolean')) ||
        (index === 1 && r.cacheSentinelPresent !== true)
    )
        throw new Error('Incomplete offline/upgrade evidence');
    return { phase, cases, report: r };
}

export function validateUpgradeRun(runs) {
    if (JSON.stringify(runs.map(r => r.phase)) !== JSON.stringify(PHASES))
        throw new Error('Wrong upgrade phase sequence');
    const fresh = runs[0].report,
        seed = runs[1].report,
        upgraded = runs[2].report;
    if (
        fresh.firstInstallTime !== fresh.lastUpdateTime ||
        runs.some(
            (r, i) =>
                r.forcedStopBefore !== true || r.processGoneBefore !== true || r.upgradedInPlaceBefore !== (i === 2),
        ) ||
        runs.some(
            ({ report: r }) =>
                r.uid !== fresh.uid ||
                r.signerSha256 !== fresh.signerSha256 ||
                r.firstInstallTime !== fresh.firstInstallTime,
        ) ||
        seed.lastUpdateTime !== fresh.lastUpdateTime ||
        upgraded.lastUpdateTime <= seed.lastUpdateTime ||
        runs[3].report.lastUpdateTime !== upgraded.lastUpdateTime ||
        runs.slice(2).some(({ report: r }) => r.fixtureSha256 !== seed.fixtureSha256 || r.pid === seed.pid)
    )
        throw new Error('Missing in-place replacement or changed identity/state');
    return runs;
}

const SETTINGS = ['airplane_mode_on', 'wifi_on', 'mobile_data'];
export async function withNetworkState(adb, work, trace = {}) {
    trace.networkRestored = false;
    const read = async () => {
        const result = {};
        for (const key of SETTINGS) {
            const value = (await adb('shell', 'settings', 'get', 'global', key)).trim();
            if (!['0', '1'].includes(value)) throw new Error(`Unknown network setting ${key}: ${value}`);
            result[key] = value;
        }
        return result;
    };
    const commands = state => [
        ['shell', 'cmd', 'connectivity', 'airplane-mode', state.airplane_mode_on === '1' ? 'enable' : 'disable'],
        ['shell', 'svc', 'wifi', state.wifi_on === '1' ? 'enable' : 'disable'],
        ['shell', 'svc', 'data', state.mobile_data === '1' ? 'enable' : 'disable'],
    ];
    trace.original = await read();
    let value, failure;
    try {
        value = await work(async online => {
            const desired = {
                airplane_mode_on: online ? '0' : '1',
                wifi_on: online ? '1' : '0',
                mobile_data: online ? '1' : '0',
            };
            for (const command of commands(desired)) await adb(...command);
            if (JSON.stringify(await read()) !== JSON.stringify(desired))
                throw new Error('Network settings did not settle');
        });
    } catch (error) {
        failure = error;
    }
    const errors = [];
    // Attempt every restoration command even if a previous radio cannot be restored.
    for (const command of commands(trace.original)) {
        try {
            await adb(...command);
        } catch (error) {
            errors.push(error);
        }
    }
    try {
        trace.restored = await read();
    } catch (error) {
        errors.push(error);
    }
    if (errors.length || JSON.stringify(trace.restored) !== JSON.stringify(trace.original)) {
        trace.restorationErrors = errors.map(e => e.message);
        throw new AggregateError(
            [...(failure ? [failure] : []), ...errors],
            'Could not restore emulator network settings',
        );
    }
    trace.networkRestored = true;
    if (failure) throw failure;
    return value;
}

async function fixtureApks(directory) {
    const manifest = JSON.parse(readFileSync(join(directory, 'fixtures.json'), 'utf8'));
    const names = ['v1.apk', 'v2.apk', 'tests.apk'];
    if (
        manifest.appId !== APP ||
        !Array.isArray(manifest.apks) ||
        JSON.stringify(manifest.apks.map(a => a.path)) !== JSON.stringify(names)
    )
        throw new Error('Unexpected upgrade fixture manifest');
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('Set ANDROID_HOME for APK identity preflight');
    const aapt = join(sdk, 'build-tools/36.0.0/aapt');
    for (const [i, apk] of manifest.apks.entries()) {
        const path = join(directory, apk.path);
        if (!HEX.test(apk.sha256) || createHash('sha256').update(readFileSync(path)).digest('hex') !== apk.sha256)
            throw new Error('APK fixture hash mismatch');
        const badging = await runInterruptionCommand(aapt, ['dump', 'badging', path], 30_000);
        const match = /^package: name='([^']+)' versionCode='([^']*)'/m.exec(badging);
        if (!match || match[1] !== (i === 2 ? APP + '.test' : APP) || (i < 2 && match[2] !== String(i + 1)))
            throw new Error('Unexpected APK package or version');
        apk.packageName = match[1];
        apk.versionCode = match[2];
    }
    const xml = await runInterruptionCommand(
        aapt,
        ['dump', 'xmltree', join(directory, 'tests.apk'), 'AndroidManifest.xml'],
        30_000,
    );
    if (!xml.includes(`android:targetPackage(0x01010021)="${APP}"`) || !xml.includes(`="${RUNNER}"`))
        throw new Error('Unexpected instrumentation target or runner');
    return manifest;
}

async function main() {
    const { values } = parseArgs({
        options: { serial: { type: 'string' }, apks: { type: 'string' }, output: { type: 'string' } },
    });
    qualificationAdbArgs(values.serial, []);
    if (!values.apks || !values.output) throw new Error('Use --serial emulator-PORT --apks DIR --output NEW_PREFIX');
    const evidence = reserveEvidence(values.output);
    const report = { serial: values.serial, outcome: 'fail', phases: [], network: {} };
    let log = '',
        installed = false;
    const adb = async (...args) => {
        log += `\n--- adb ${args.join(' ')} ---\n`;
        try {
            const result = await runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), 240_000);
            log += result;
            return result;
        } catch (error) {
            log += `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
            throw error;
        }
    };
    const install = async name => {
        if (!(await adb('install', '-r', join(resolve(values.apks), name))).includes('Success'))
            throw new Error('APK install failed');
    };
    const stop = async () => {
        await adb('shell', 'am', 'force-stop', APP);
        let pid;
        try {
            pid = await adb('shell', 'pidof', APP);
        } catch (error) {
            if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw error;
            pid = '';
        }
        if (pid.trim()) throw new Error('App process remains after force-stop');
    };
    try {
        if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
        report.avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
        report.pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
        validateQualificationEnvironment(report.avd, report.pageSize);
        report.api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim());
        if (!Number.isSafeInteger(report.api) || report.api < 35)
            throw new Error('Upgrade qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        report.fixtures = await fixtureApks(resolve(values.apks));
        await withNetworkState(
            adb,
            async setOnline => {
                await setOnline(false);
                const packages = (await adb('shell', 'pm', 'list', 'packages', APP)).trim().split(/\r?\n/);
                if (packages.includes('package:' + APP) && !(await adb('uninstall', APP)).includes('Success'))
                    throw new Error('Could not remove disposable previous installation');
                await install('v1.apk');
                installed = true;
                await install('tests.apk');
                for (const [i, phase] of PHASES.entries()) {
                    await setOnline(i % 2 === 1);
                    if (i === 2) await install('v2.apk');
                    await stop();
                    console.log(`Running ${phase} on ${values.serial}`);
                    const output = await adb(
                        'shell',
                        'am',
                        'instrument',
                        '-w',
                        '-r',
                        '-e',
                        'class',
                        `${CLASS}#${phase}`,
                        `${APP}.test/${RUNNER}`,
                    );
                    report.phases.push({
                        ...parseUpgradePhase(output, phase),
                        forcedStopBefore: true,
                        processGoneBefore: true,
                        upgradedInPlaceBefore: i === 2,
                    });
                }
                validateUpgradeRun(report.phases);
                // CacheStorage is disposable. A missing sentinel must stay visible as
                // an unmet cache-retention check, independently of the core upgrade gate.
                report.cacheRetention = report.phases.slice(2).every(r => r.report.cacheSentinelPresent)
                    ? 'retained'
                    : 'not-retained';
            },
            report.network,
        );
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="offline-upgrade ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="4" failures="0" skipped="0">\n` +
                '  <properties>\n' +
                '    <property name="scope" value="core offline launch and controlled APK replacement; cache retention is separate"/>\n' +
                `    <property name="cacheRetention" value="${report.cacheRetention}"/>\n` +
                '    <property name="legacyWorkerRecovery" value="not-tested"/>\n' +
                '  </properties>\n' +
                report.phases
                    .flatMap(r =>
                        r.cases.map(c => `  <testcase classname="${escape(c.className)}" name="${escape(c.name)}"/>`),
                    )
                    .join('\n') +
                '\n</testsuite>\n',
        );
        report.outcome = 'pass';
    } catch (error) {
        report.error = error.message;
        if (installed) {
            try {
                await stop();
            } catch {
                report.stopFailed = true;
            }
        }
        throw error;
    } finally {
        try {
            evidence.write('log', log);
            evidence.write('json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            evidence.close();
        }
    }
    console.log(
        JSON.stringify({
            outcome: report.outcome,
            serial: values.serial,
            cases: report.phases.length,
            cacheRetention: report.cacheRetention,
        }),
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
