#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--android')) {
    console.error('Usage: node scripts/mobile/doctor.mjs [--android]');
    process.exit(2);
}

let failures = 0;
const report = (ok, message) => {
    console.log(`${ok ? 'OK' : 'FAIL'} ${message}`);
    if (!ok) failures += 1;
};
const command = (executable, options) => {
    const result = spawnSync(executable, options, { encoding: 'utf8', timeout: 15_000 });
    return { ok: !result.error && result.status === 0, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const pinnedNode = readFileSync(join(root, '.node-version'), 'utf8').trim();
report(process.versions.node === pinnedNode, `Node ${process.versions.node}; select ${pinnedNode} from .node-version`);
const npm = command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
report(npm.ok, `npm ${npm.text || 'unavailable; install npm with the selected Node distribution'}`);

if (args.includes('--android')) {
    const javaHome = process.env.JAVA_HOME;
    const java = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    const version = command(java, ['-version']);
    const javaMajor = /version "(\d+)/.exec(version.text)?.[1];
    report(version.ok && javaMajor === '21', `JDK 21: ${java}; ${version.text.split('\n')[0] || 'not found'}`);
    if (!version.ok || javaMajor !== '21')
        console.log('Set JAVA_HOME to a JDK 21 installation before building Android.');

    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    report(Boolean(sdk && existsSync(sdk)), `Android SDK: ${sdk || 'set ANDROID_HOME to an installed Android SDK'}`);
    if (sdk && existsSync(sdk)) {
        for (const path of ['platforms/android-36/android.jar', 'build-tools/36.0.0/source.properties']) {
            report(existsSync(join(sdk, path)), `SDK package ${path}`);
        }
        const adbPath = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
        const adb = command(adbPath, ['version']);
        report(adb.ok, `adb: ${adb.text.split('\n')[0] || `install platform-tools under ${sdk}`}`);
        console.log('Use a dedicated synthetic-data device; this check does not start or modify devices.');
    }
    const wrapper = join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    console.log(
        existsSync(wrapper)
            ? `Gradle wrapper: ${readFileSync(wrapper, 'utf8').match(/^distributionUrl=(.+)$/m)?.[1] ?? 'missing URL'}`
            : 'Gradle wrapper: not generated yet; the Android host task creates it.',
    );
}

console.log(
    failures ? `${failures} prerequisite check(s) failed. No tools were installed or changed.` : 'Prerequisites OK.',
);
process.exitCode = failures ? 1 : 0;
