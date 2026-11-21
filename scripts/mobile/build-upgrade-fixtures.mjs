import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInterruptionCommand } from './screen-interruption.mjs';

export function upgradeOverlay(html, stage) {
    if (![1, 2].includes(stage)) throw new Error('Upgrade fixture stage must be 1 or 2');
    const head = html.indexOf('</head>');
    const csp = html.indexOf('http-equiv="Content-Security-Policy"');
    const script = html.indexOf('<script');
    if (head < 0 || csp < 0 || csp > head || (script >= 0 && csp > script) || /__hrtUpgrade|__hrt_upgrade/.test(html))
        throw new Error('Expected unmodified ordinary HTML with CSP before scripts');
    return {
        html: html.slice(0, head) + '<script src="/assets/__hrt_upgrade_canary__.js"></script>' + html.slice(head),
        script: `Object.defineProperty(window,'__hrtUpgradeAssetVersion',{value:${stage}});\n`,
    };
}

async function main() {
    const { values } = parseArgs({ options: { output: { type: 'string' } } });
    if (!values.output) throw new Error('Use --output NEW_DIRECTORY after ordinary android:sync');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const html = readFileSync(join(root, 'android/app/src/main/assets/public/index.html'), 'utf8');
    if (html !== readFileSync(join(root, 'dist-mobile/index.html'), 'utf8'))
        throw new Error('Run ordinary android:sync first');
    const plugins = JSON.parse(readFileSync(join(root, 'android/app/src/main/assets/capacitor.plugins.json'), 'utf8'));
    if (JSON.stringify(plugins.map(p => p.pkg)) !== JSON.stringify(['@capacitor/app']))
        throw new Error('Upgrade fixtures require the ordinary plugin configuration');
    const out = resolve(values.output);
    mkdirSync(out); // Exclusive: never replace evidence from an earlier build.
    for (const stage of [1, 2]) {
        const overlay = upgradeOverlay(html, stage);
        const dir = join(root, `android/app/build/generated/upgrade/${stage}/assets/public`);
        mkdirSync(join(dir, 'assets'), { recursive: true });
        writeFileSync(join(dir, 'index.html'), overlay.html);
        writeFileSync(join(dir, 'assets/__hrt_upgrade_canary__.js'), overlay.script);
        console.log(`Building disposable upgrade fixture ${stage}`);
        let log = '';
        try {
            log = await runInterruptionCommand(
                join(root, 'android/gradlew'),
                [
                    '-p',
                    join(root, 'android'),
                    `-PupgradeQualification=${stage}`,
                    ':app:assembleUpgradeQualification',
                    ':app:assembleUpgradeQualificationAndroidTest',
                ],
                240_000,
            );
        } catch (error) {
            log = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
            throw error;
        } finally {
            writeFileSync(join(out, `build-v${stage}.log`), log);
        }
        copyFileSync(
            join(root, 'android/app/build/outputs/apk/upgradeQualification/app-upgradeQualification.apk'),
            join(out, `v${stage}.apk`),
        );
        if (stage === 2)
            copyFileSync(
                join(
                    root,
                    'android/app/build/outputs/apk/androidTest/upgradeQualification/app-upgradeQualification-androidTest.apk',
                ),
                join(out, 'tests.apk'),
            );
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    writeFileSync(
        join(out, 'fixtures.json'),
        JSON.stringify(
            {
                sourceCommit: git('rev-parse', 'HEAD'),
                workingTreeDirty: Boolean(git('status', '--porcelain')),
                appId: 'org.askarys.hrttracker.spike.upgradequalification',
                apks: ['v1.apk', 'v2.apk', 'tests.apk'].map(path => ({
                    path,
                    sha256: createHash('sha256')
                        .update(readFileSync(join(out, path)))
                        .digest('hex'),
                })),
            },
            null,
            2,
        ) + '\n',
    );
    console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
