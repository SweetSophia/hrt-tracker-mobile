import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { analyseRendererTrace } from '../../scripts/mobile/renderer-trace.mjs';

const runReplay = process.env.HRT_RENDERER_REPLAY === '1';
const replayTest = it.runIf(runReplay);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = 'export const leaf = 1;\n';
const CODE = 'const leaf = 1;\n';
const MAP = {
    version: 3,
    file: 'app.js',
    sources: ['../../src/leaf.ts'],
    sourcesContent: [SOURCE],
    names: [] as string[],
    mappings: 'AAAA',
};
const measurement = {
    outcome: 'pass',
    measurementOnly: true,
    performanceAccepted: false,
    rendererProfile: true,
    trace: {
        phase: 'complete',
        workerId: 3,
        requestId: 4,
        attempts: 1,
        discardedAttempts: 0,
        metrics: {
            actionToPostMs: 1,
            postToStartedMs: 1,
            startedToResultMs: 1,
            resultToFrameMs: 1,
            totalMs: 4,
        },
    },
};
const marker = (name: string, startMs: number, ts: number) => ({
    name,
    ph: 'I',
    cat: 'blink.user_timing',
    pid: 1,
    tid: 2,
    ts,
    args: { data: { startTime: startMs } },
});
const capture = {
    complete: true,
    dataLossOccurred: false,
    traceEvents: [
        { name: 'thread_name', ph: 'M', cat: '__metadata', pid: 1, tid: 2, ts: 0, args: { name: 'CrRendererMain' } },
        marker('hrt.renderer.action.0.0', 0, 0),
        marker('hrt.renderer.post.3.4', 1, 1000),
        marker('hrt.renderer.started.3.4', 2, 2000),
        marker('hrt.renderer.result.3.4', 3, 3000),
        marker('hrt.renderer.frame.3.4', 4, 4000),
        { name: 'RunTask', ph: 'X', cat: 'toplevel', pid: 1, tid: 2, ts: 0, dur: 4000 },
        { name: 'Profile', ph: 'P', id: 'p', pid: 1, tid: 2, args: { data: { startTime: 0 } } },
        {
            name: 'ProfileChunk',
            ph: 'P',
            id: 'p',
            pid: 1,
            tid: 2,
            args: {
                data: {
                    cpuProfile: {
                        nodes: [
                            { id: 1, callFrame: { functionName: '(root)' } },
                            {
                                id: 2,
                                parent: 1,
                                callFrame: {
                                    functionName: 'leaf',
                                    url: 'https://localhost/assets/app.js',
                                    lineNumber: 0,
                                    columnNumber: 0,
                                },
                            },
                        ],
                        samples: [2],
                    },
                    timeDeltas: [1000],
                },
            },
        },
    ],
};
const analysed = analyseRendererTrace(capture, measurement);

function copyCli(checkout: string) {
    const scripts = join(checkout, 'scripts', 'mobile');
    mkdirSync(scripts, { recursive: true });
    for (const name of ['map-renderer-frames.mjs', 'renderer-source-map.mjs', 'renderer-trace.mjs']) {
        copyFileSync(new URL('../../scripts/mobile/' + name, import.meta.url), join(scripts, name));
    }
}

function placeBuild(checkout: string) {
    const build = join(checkout, 'build');
    const assets = join(build, 'assets');
    mkdirSync(assets, { recursive: true });
    mkdirSync(join(checkout, 'src'), { recursive: true });
    writeFileSync(join(assets, 'app.js'), CODE);
    writeFileSync(join(assets, 'app.js.map'), JSON.stringify(MAP));
    writeFileSync(join(checkout, 'src', 'leaf.ts'), SOURCE);
    return build;
}

function git(checkout: string, ...args: string[]) {
    return execFileSync('git', ['-C', checkout, '-c', 'core.hooksPath=' + join(checkout, 'disabled-hooks'), ...args], {
        env: environment,
        encoding: 'utf8',
        timeout: 5000,
    });
}

function fixture(checkout: string) {
    git(checkout, 'init', '-q');
    copyCli(checkout);
    const apk = join(checkout, 'app-storageQualification.apk');
    execFileSync(
        'python3',
        [
            '-c',
            'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as apk:\n    apk.writestr("assets/public/assets/app.js", sys.stdin.buffer.read())',
            apk,
        ],
        { input: CODE, timeout: 5000 },
    );
    const apkSha256 = digest(readFileSync(apk));
    const raw = Buffer.from(JSON.stringify(capture));
    const archived = gzipSync(raw);
    writeFileSync(join(checkout, 'trace.json.gz'), archived);
    const report = {
        api: 36,
        pageSize: 4096,
        outcome: 'pass',
        reports: [measurement],
        apks: [{ path: 'storageQualification/app-storageQualification.apk', sha256: apkSha256 }],
        rendererProfile: analysed,
    };
    const evidence = {
        json: { sha256: digest(JSON.stringify(report, null, 2) + '\n') },
        compressedTrace: { path: 'trace.json.gz', sha256: digest(archived), uncompressedSha256: digest(raw) },
        rawTrace: { sha256: digest(raw) },
    };
    const build = placeBuild(checkout);
    const replay = (
        label: string,
        { buildDirectory = build, embeddedReport = report, scriptCheckout = checkout, env = environment } = {},
    ) => {
        const manifest = JSON.stringify({
            version: 1,
            measurementOnly: true,
            performanceAccepted: false,
            sourceCommit: 'a'.repeat(40),
            qualificationApks: [{ path: 'app-storageQualification.apk', sha256: apkSha256 }],
            installed: { profiled: [{ report: embeddedReport, evidence }] },
        });
        const manifestPath = join(checkout, label + '-manifest.json');
        const pinsPath = join(checkout, label + '-pins.json');
        const output = join(checkout, label + '-frames.json');
        writeFileSync(manifestPath, manifest);
        // Re-pin the outer manifest so a changed label reaches the original run report check.
        writeFileSync(
            pinsPath,
            JSON.stringify({
                version: 1,
                manifestSha256: digest(manifest),
                qualificationApkSha256: apkSha256,
                mappedAssets: [
                    { name: 'app.js', javaScriptSha256: digest(CODE), sourceMapSha256: digest(JSON.stringify(MAP)) },
                ],
            }),
        );
        const result = spawnSync(
            process.execPath,
            [
                join(scriptCheckout, 'scripts/mobile/map-renderer-frames.mjs'),
                '--manifest',
                manifestPath,
                '--apk',
                apk,
                '--build',
                buildDirectory,
                '--map-pins',
                pinsPath,
                '--output',
                output,
            ],
            { cwd: scriptCheckout, env, encoding: 'utf8', timeout: 5000 },
        );
        expect(result.error).toBeUndefined();
        return { status: result.status, stderr: result.stderr, output };
    };
    return { build, report, replay };
}

function withCheckout(run: (checkout: string, built: ReturnType<typeof fixture>) => void) {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'hrt-renderer-cli-')));
    try {
        run(checkout, fixture(checkout));
    } finally {
        rmSync(checkout, { recursive: true, force: true });
    }
}

replayTest(
    'replays pinned device labels and rejects altered labels before writing a report',
    () => {
        withCheckout((_checkout, { report, replay }) => {
            const valid = replay('valid');
            expect(valid.status, valid.stderr).toBe(0);
            expect(JSON.parse(readFileSync(valid.output, 'utf8')).captures).toEqual([
                expect.objectContaining({
                    api: 36,
                    pageSize: 4096,
                    frames: [
                        expect.objectContaining({ original: { path: 'src/leaf.ts', line: 1, column: 1, name: null } }),
                    ],
                }),
            ]);

            const altered = replay('altered', { embeddedReport: { ...report, api: 37, pageSize: 16384 } });
            expect(altered.status).toBe(1);
            expect(altered.stderr).toContain('Run report hash differs');
            expect(existsSync(altered.output)).toBe(false);
        });
    },
    15000,
);

replayTest(
    'checks ownership in both the outer and nested Git worktrees',
    () => {
        withCheckout((checkout, { replay }) => {
            git(
                checkout,
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-q',
                '--allow-empty',
                '--no-gpg-sign',
                '-m',
                'Fixture',
            );
            const nested = join(checkout, 'nested');
            git(checkout, 'worktree', 'add', '--quiet', '--detach', nested, 'HEAD');

            const buildDirectory = placeBuild(nested);
            const rejected = replay('nested', { buildDirectory });
            expect(rejected.status).toBe(1);
            expect(rejected.stderr).toContain('Build and replay must use the same checkout');
            expect(existsSync(rejected.output)).toBe(false);

            copyCli(nested);
            copyFileSync(join(checkout, 'trace.json.gz'), join(nested, 'trace.json.gz'));
            const own = replay('nested-own', { buildDirectory, scriptCheckout: nested });
            expect(own.status, own.stderr).toBe(0);
            expect(JSON.parse(readFileSync(own.output, 'utf8')).captures[0].frames[0].original.path).toBe(
                'src/leaf.ts',
            );
        });
    },
    15000,
);

replayTest(
    'ignores an inherited Git discovery ceiling inside the checkout',
    () => {
        withCheckout((_checkout, { build, replay }) => {
            const own = replay('ceiling', { env: { ...environment, GIT_CEILING_DIRECTORIES: build } });
            expect(own.status, own.stderr).toBe(0);
            expect(existsSync(own.output)).toBe(true);
        });
    },
    15000,
);

replayTest(
    'rejects a nested Git directory even when core.worktree points at the outer checkout',
    () => {
        withCheckout((checkout, { replay }) => {
            const nested = join(checkout, 'reconfigured');
            mkdirSync(nested);
            git(nested, 'init', '-q');
            git(nested, 'config', 'core.worktree', checkout);
            const buildDirectory = placeBuild(nested);
            expect(realpathSync(git(buildDirectory, 'rev-parse', '--show-toplevel').trim())).toBe(checkout);
            const mismatched = replay('reconfigured', { buildDirectory });
            expect(mismatched.status).toBe(1);
            expect(mismatched.stderr).toContain('Build and replay must use the same checkout');
            expect(existsSync(mismatched.output)).toBe(false);
        });
    },
    15000,
);

replayTest(
    'reports a Git lookup failure separately from a checkout mismatch',
    () => {
        withCheckout((checkout, { replay }) => {
            rmSync(join(checkout, '.git'), { recursive: true });
            writeFileSync(join(checkout, '.git'), 'gitdir: ./missing-git-dir\n');
            const gitError = spawnSync('git', ['rev-parse', '--show-toplevel'], {
                cwd: checkout,
                env: environment,
                encoding: 'utf8',
                timeout: 5000,
            });
            expect(gitError.status).toBe(128);
            expect(gitError.stderr.trim()).not.toBe('');
            const failed = replay('unreadable');
            expect(failed.status).toBe(1);
            expect(failed.stderr).toContain('Could not determine Git checkout ownership');
            expect(failed.stderr).toContain(gitError.stderr.trim());
            expect(existsSync(failed.output)).toBe(false);
        });
    },
    15000,
);

replayTest(
    'refuses a nested Git directory that Git skips because HEAD is missing',
    () => {
        withCheckout((checkout, { replay }) => {
            const nested = join(checkout, 'nested');
            const buildDirectory = placeBuild(nested);
            mkdirSync(join(nested, '.git'));
            const rejected = replay('skipped-head', { buildDirectory });
            expect(rejected.status).toBe(1);
            expect(existsSync(rejected.output)).toBe(false);
        });
    },
    15000,
);

replayTest(
    'keeps ownership when a relative Git object directory exists only from the build assets',
    () => {
        withCheckout((checkout, { build, replay }) => {
            const relativeObjects = 'rel-objects';
            mkdirSync(join(build, 'assets', relativeObjects));
            expect(existsSync(join(checkout, relativeObjects))).toBe(false);
            const own = replay('object-directory', {
                env: { ...environment, GIT_OBJECT_DIRECTORY: relativeObjects },
            });
            expect(own.status, own.stderr).toBe(0);
            expect(JSON.parse(readFileSync(own.output, 'utf8')).captures[0].frames[0].original.path).toBe(
                'src/leaf.ts',
            );
        });
    },
    15000,
);

it.runIf(runReplay && process.platform !== 'win32')(
    'replays a POSIX checkout whose path contains newlines',
    () => {
        const parent = realpathSync(mkdtempSync(join(tmpdir(), 'hrt-renderer-cli-')));
        const checkout = join(parent, 'check\nout\n');
        mkdirSync(checkout);
        try {
            const { replay } = fixture(checkout);
            const replayed = replay('newline');
            expect(replayed.status, replayed.stderr).toBe(0);
            expect(JSON.parse(readFileSync(replayed.output, 'utf8')).captures[0].frames[0].original.path).toBe(
                'src/leaf.ts',
            );
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    },
    15000,
);

replayTest(
    'rejects a matching build nested inside a bare repository',
    () => {
        withCheckout((checkout, { replay }) => {
            const bare = join(checkout, 'cache.git');
            git(checkout, 'init', '-q', '--bare', bare);
            const rejected = replay('bare', { buildDirectory: placeBuild(bare) });
            expect(rejected.status).toBe(1);
            expect(existsSync(rejected.output)).toBe(false);
        });
    },
    15000,
);

it.runIf(runReplay && process.platform === 'win32')(
    'accepts a differently cased path to the same Windows checkout',
    context => {
        withCheckout((checkout, { build, replay }) => {
            const buildDirectory = join(dirname(checkout), basename(checkout).toUpperCase(), basename(build));
            if (!existsSync(buildDirectory)) context.skip('Requires a case-insensitive checkout volume');

            const own = replay('checkout-case', { buildDirectory });
            expect(own.status, own.stderr).toBe(0);
            expect(JSON.parse(readFileSync(own.output, 'utf8')).captures[0].frames[0].original.path).toBe(
                'src/leaf.ts',
            );
        });
    },
    15000,
);

it.runIf(runReplay && process.platform !== 'win32')(
    'preserves Git ownership checks and protected configuration for a shared checkout',
    () => {
        withCheckout((checkout, { replay }) => {
            const bin = join(checkout, 'test-bin');
            const config = join(checkout, 'test.gitconfig');
            const gitLog = join(checkout, 'git-arguments.log');
            const gitBinary = execFileSync('sh', ['-c', 'command -v git'], {
                encoding: 'utf8',
                env: environment,
                timeout: 5000,
            }).trimEnd();
            mkdirSync(bin);
            // Exercise Git's ownership check without changing the fixture's filesystem owner.
            writeFileSync(
                join(bin, 'git'),
                [
                    '#!/bin/sh',
                    'if [ -n "$HRT_FIXTURE_GIT_LOG" ]; then printf "%s\\n" "$@" >> "$HRT_FIXTURE_GIT_LOG"; fi',
                    'GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec "$HRT_FIXTURE_GIT" "$@"',
                    '',
                ].join('\n'),
                {
                    mode: 0o755,
                },
            );
            git(checkout, 'config', '--file', config, '--add', 'safe.directory', '');
            const env = {
                ...environment,
                PATH: [bin, environment.PATH ?? '/usr/bin:/bin'].join(':'),
                HRT_FIXTURE_GIT: gitBinary,
                LC_ALL: 'C',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: config,
            };
            const denied = replay('shared-denied', { env });
            expect(denied.status).toBe(1);
            expect(denied.stderr).toContain('Could not determine Git checkout ownership');
            expect(denied.stderr).toContain('dubious ownership');
            expect(existsSync(denied.output)).toBe(false);

            git(checkout, 'config', '--file', config, '--add', 'safe.directory', checkout);
            const allowed = replay('shared-allowed', { env });
            expect(allowed.status, allowed.stderr).toBe(0);
            expect(existsSync(allowed.output)).toBe(true);

            const relativeConfig = replay('shared-relative-config', {
                env: { ...env, GIT_CONFIG_GLOBAL: basename(config) },
            });
            expect.soft(relativeConfig.status, relativeConfig.stderr).toBe(0);

            const configDirectory = join(checkout, 'configs');
            const child = join(configDirectory, 'child');
            mkdirSync(child, { recursive: true });
            symlinkSync(child, join(checkout, 'config-link'), 'dir');
            git(
                checkout,
                'config',
                '--file',
                join(configDirectory, 'trusted.gitconfig'),
                '--add',
                'safe.directory',
                checkout,
            );
            const aliasedConfig = 'config-link/../trusted.gitconfig';
            for (const [label, value] of [
                ['relative', aliasedConfig],
                ['absolute', checkout + '/' + aliasedConfig],
            ]) {
                const own = replay('shared-symlink-' + label, { env: { ...env, GIT_CONFIG_GLOBAL: value } });
                expect.soft(own.status, own.stderr).toBe(0);
            }

            const relativeGit = replay('shared-relative-git', {
                env: {
                    ...env,
                    PATH: [basename(bin), environment.PATH ?? '/usr/bin:/bin'].join(':'),
                    HRT_FIXTURE_GIT_LOG: gitLog,
                },
            });
            expect(relativeGit.status, relativeGit.stderr).toBe(0);
            expect(readFileSync(gitLog, 'utf8').split('\n')).toContain('--absolute-git-dir');
        });
    },
    15000,
);
