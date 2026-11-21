import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';

const nativeLog = 'synthetic native stdout\nsynthetic native stderr\n';

// The production runner and its real child-process/evidence helpers run in a
// subprocess. Only ADB, the installed APKs and the DevTools peer are faked.
const device = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.shift() !== '-s' || args.shift() !== 'emulator-5580') throw new Error('Bad target');
const command = args.join(' ');
const replies = {
    'get-state': 'device',
    'emu avd name': 'HRT_Feasibility_API36',
    'shell getconf PAGE_SIZE': '4096',
    'shell getprop ro.build.version.sdk': '36',
    'shell getprop ro.product.cpu.abi': 'x86_64',
};
if (Object.hasOwn(replies, command)) console.log(replies[command]);
else if (command.startsWith('install -r ')) console.log('Success');
else if (command === 'shell am force-stop org.askarys.hrttracker.spike.storagequalification') {
    fs.appendFileSync('stops', 'stop\\n');
} else if (command === 'forward tcp:0 localabstract:fixture') {
    fs.writeFileSync('forward', '');
    console.log('4567');
} else if (command === 'forward --remove tcp:4567') fs.unlinkSync('forward');
else if (command.startsWith('shell am instrument ')) {
    fs.writeSync(1, 'synthetic native stdout\\n');
    fs.writeSync(2, 'synthetic native stderr\\n');
    fs.writeFileSync('instrumentation-pid', String(process.pid));
    const parent = process.ppid;
    setInterval(() => {
        if (process.ppid !== parent || fs.existsSync('trace-finished')) process.exit(7);
        if (fs.readFileSync('stops', 'utf8') === 'stop\\nstop\\n') process.exit(8);
    }, 10);
} else throw new Error('Unexpected ADB command');
`;

const renderer = `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
export async function captureRendererTrace({ adb, signal }) {
    await adb('forward', 'tcp:0', 'localabstract:fixture');
    const capture = { complete: false, traceEvents: [{ name: 'fixture' }] };
    try {
        while (!existsSync('instrumentation-pid')) await wait(10, undefined, { signal });
        if (process.env.HRT_TEST_FAILURE === 'native') {
            return { ...capture, complete: true };
        }
        if (process.env.HRT_TEST_FAILURE === 'renderer') {
            throw Object.assign(new Error('Synthetic renderer failure'), {
                forwardCleanupError: new Error('Synthetic forward removal failure'),
            });
        }
        await wait(10_000, undefined, { signal });
        throw new Error('Expected a host signal');
    } catch (error) {
        error.capture = capture;
        throw error;
    } finally {
        if (process.env.HRT_TEST_FAILURE !== 'renderer') {
            await adb('forward', '--remove', 'tcp:4567');
        }
        if (process.env.HRT_TEST_FAILURE === 'native') writeFileSync('trace-finished', '');
    }
}
`;

async function run(failure: 'native' | 'renderer' | 'SIGINT' | 'SIGTERM') {
    const dir = mkdtempSync(join(tmpdir(), 'hrt-long-history-cli-'));
    const scripts = join(dir, 'scripts', 'mobile');
    const read = (name: string) => readFileSync(join(dir, name), 'utf8');
    const exists = (name: string) => existsSync(join(dir, name));
    const apkRoot = join(dir, 'android', 'app', 'build', 'outputs', 'apk');
    mkdirSync(scripts, { recursive: true });
    for (const name of [
        'run-native-long-history.mjs',
        'run-native-storage-qualification.mjs',
        'backup-evidence.mjs',
        'renderer-trace.mjs',
        'screen-interruption.mjs',
    ]) {
        copyFileSync(new URL('../../scripts/mobile/' + name, import.meta.url), join(scripts, name));
    }
    for (const apk of [
        'storageQualification/app-storageQualification.apk',
        'androidTest/storageQualification/app-storageQualification-androidTest.apk',
    ]) {
        const path = join(apkRoot, apk);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'synthetic APK');
    }
    writeFileSync(join(dir, 'adb'), device, { mode: 0o700 });
    writeFileSync(join(scripts, 'renderer-cdp.mjs'), renderer);
    const child = spawn(
        process.execPath,
        [
            join(scripts, 'run-native-long-history.mjs'),
            '--serial',
            'emulator-5580',
            '--output',
            'out',
            '--renderer-profile',
        ],
        {
            cwd: dir,
            env: {
                ...process.env,
                PATH: [dir, dirname(process.execPath), process.env.PATH].join(delimiter),
                HRT_TEST_FAILURE: failure,
            },
            stdio: 'ignore',
        },
    );
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    try {
        if (failure === 'SIGINT' || failure === 'SIGTERM') {
            await vi.waitFor(() => expect(exists('forward') && exists('instrumentation-pid')).toBe(true), {
                timeout: 5000,
            });
            child.kill(failure);
        }
        expect(await exited).toEqual({ code: 1, signal: null });
        expect(read('out.xml')).toBe('');
        expect(exists('out.lock')).toBe(false);
        expect(read('stops')).toMatch(/^stop\nstop\n/);
        expect(exists('forward')).toBe(failure === 'renderer');
        const pid = Number(read('instrumentation-pid'));
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
        return {
            log: read('out.log'),
            trace: read('out.trace.json'),
            report: JSON.parse(read('out.json')),
        };
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        rmSync(dir, { recursive: true, force: true });
    }
}

it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'settles a profiled run and releases its forward on %s',
    async signal => {
        const result = await run(signal);
        expect(result.report).toMatchObject({ outcome: 'fail', error: expect.stringContaining(signal) });
        expect(result.log).toBe(nativeLog);
        expect(JSON.parse(result.trace)).toMatchObject({ complete: false, traceEvents: [{ name: 'fixture' }] });
    },
    9000,
);

it.skipIf(process.platform === 'win32')(
    'retains a completed trace when native instrumentation rejects later',
    async () => {
        const result = await run('native');
        expect(result.report).toMatchObject({ outcome: 'fail', error: expect.stringContaining('am instrument') });
        expect(result.log).toBe(nativeLog);
        expect(result.trace).not.toBe('');
        expect(JSON.parse(result.trace)).toMatchObject({ complete: true, traceEvents: [{ name: 'fixture' }] });
    },
    9000,
);

it.skipIf(process.platform === 'win32')(
    'retains native buffers and partial trace when capture fails first',
    async () => {
        const result = await run('renderer');
        expect(result.log).toBe(nativeLog);
        expect(result.report).toMatchObject({
            outcome: 'fail',
            error: 'Synthetic renderer failure',
            forwardCleanupError: 'Synthetic forward removal failure',
        });
        expect(JSON.parse(result.trace)).toMatchObject({ complete: false, traceEvents: [{ name: 'fixture' }] });
    },
    9000,
);
