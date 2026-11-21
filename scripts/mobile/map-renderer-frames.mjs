import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { mapRendererFrames } from './renderer-source-map.mjs';
import { analyseRendererTrace } from './renderer-trace.mjs';

const root = realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const apkPathInReport = 'storageQualification/app-storageQualification.apk';

// Inspect ZIP members without extracting paths from the archive.
const apkAssetHashes = apk =>
    JSON.parse(
        execFileSync(
            'python3',
            [
                '-c',
                `from hashlib import sha256
from io import BytesIO
from zipfile import ZipFile
import json
import sys

prefix = 'assets/public/assets/'
hashes = {}
with ZipFile(BytesIO(sys.stdin.buffer.read())) as apk:
    for item in apk.infolist():
        if item.filename.startswith(prefix) and item.filename.endswith('.js'):
            name = item.filename[len(prefix):]
            if name in hashes:
                raise ValueError('Duplicate APK JavaScript asset')
            hashes[name] = sha256(apk.read(item)).hexdigest()
print(json.dumps(hashes))`,
            ],
            { input: apk, encoding: 'utf8' },
        ),
    );

function verifiedJavaScript(apk, assets) {
    const apkHashes = apkAssetHashes(apk);
    const installed = Object.keys(apkHashes).sort();
    const rebuilt = readdirSync(assets)
        .filter(name => name.endsWith('.js'))
        .sort();
    if (!installed.length || !isDeepStrictEqual(rebuilt, installed))
        throw new Error('Rebuilt JavaScript asset set differs from the qualification APK');
    return new Map(
        installed.map(name => {
            const bytes = readFileSync(join(assets, name));
            if (hash(bytes) !== apkHashes[name]) throw new Error('Rebuilt JavaScript differs from the APK: ' + name);
            return [name, { code: bytes.toString('utf8'), sha256: apkHashes[name] }];
        }),
    );
}

export function verifyRendererTrace(archived, { compressedTrace, rawTrace }) {
    if (hash(archived) !== compressedTrace.sha256)
        throw new Error('Compressed trace hash differs from the measurement pin');
    const raw = gunzipSync(archived, { maxOutputLength: 64 * 1024 * 1024 });
    const rawTraceSha256 = hash(raw);
    if (rawTraceSha256 !== compressedTrace.uncompressedSha256 || rawTraceSha256 !== rawTrace?.sha256)
        throw new Error('Raw trace hash differs from the measurement pins');
    return { capture: JSON.parse(raw.toString('utf8')), rawTraceSha256 };
}

export function verifyRendererRunReport(report, pin) {
    // Use the original native runner's encoding, independent of manifest formatting.
    if (hash(JSON.stringify(report, null, 2) + '\n') !== pin?.sha256)
        throw new Error('Run report hash differs from the original measurement pin');
}

function repositoryPath(path) {
    const name = relative(root, path);
    return !name || name === '..' || name.startsWith('..' + sep) || isAbsolute(name) ? null : name.split(sep).join('/');
}

function gitPath(directory, env, ...options) {
    try {
        // Keep executable lookup in the caller's working directory for every probe.
        const output = execFileSync('git', ['-C', directory, 'rev-parse', ...options], {
            encoding: 'utf8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Query one path at a time and strip only Git's terminator.
        const path = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
        return realpathSync.native(resolve(directory, path));
    } catch (error) {
        const diagnostic = error.stderr?.trim() || error.message;
        throw new Error('Could not determine Git checkout ownership for ' + directory + '\n' + diagnostic, {
            cause: error,
        });
    }
}

function callerConfigPath(file) {
    if (!file) return file;
    const { root: prefix } = parse(file);
    if (isAbsolute(file) && (process.platform !== 'win32' || prefix.length !== 1)) return file;

    // Resolve Windows drive and root prefixes without normalizing symlink and parent path components.
    const base = prefix ? resolve(prefix) : process.cwd();
    return base + (base.endsWith(sep) ? '' : sep) + file.slice(prefix.length);
}

function verifyBuildCheckout(assets) {
    const mismatch = 'Build and replay must use the same checkout';
    const buildPath = repositoryPath(assets);
    if (!buildPath) throw new Error(mismatch);

    // Discovery can skip a damaged .git entry. Walk the build path relative to the physical root.
    for (let directory = buildPath; directory !== '.'; directory = dirname(directory)) {
        const marker = join(root, directory, '.git');
        if (lstatSync(marker, { throwIfNoEntry: false }))
            throw new Error(mismatch + '. Nested Git marker at ' + marker);
    }

    // Anchor protected config paths before Git changes directories.
    const configPaths = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        const name = key.toUpperCase();
        if (configPaths.has(name)) env[key] = callerConfigPath(value);
        else if (!name.startsWith('GIT_') || name === 'GIT_CONFIG_NOSYSTEM') env[key] = value;
    }
    env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '1';
    const parent = dirname(root);
    if (!parent.includes(delimiter)) env.GIT_CEILING_DIRECTORIES = parent;

    // Normal discovery honors safe.directory and detects bare repositories along the build path.
    if (gitPath(root, env, '--show-toplevel') !== root || gitPath(assets, env, '--show-toplevel') !== root)
        throw new Error(mismatch);
    const checkoutGitDirectory = gitPath(root, env, '--resolve-git-dir', '.git');
    if (gitPath(assets, env, '--absolute-git-dir') !== checkoutGitDirectory) throw new Error(mismatch);
}

function main() {
    const { values } = parseArgs({
        options: {
            manifest: { type: 'string' },
            apk: { type: 'string' },
            build: { type: 'string' },
            'map-pins': { type: 'string' },
            output: { type: 'string' },
        },
    });
    const { manifest, apk, build, 'map-pins': mapPinsPath, output } = values;
    if (!manifest || !apk || !build || !mapPinsPath || !output)
        throw new Error(
            'Use --manifest PROFILE.json --apk QUALIFICATION.apk --build REBUILT_DIR --map-pins ATTRIBUTION.json --output NEW.json',
        );

    const manifestBytes = readFileSync(manifest);
    const manifestSha256 = hash(manifestBytes);
    const record = JSON.parse(manifestBytes.toString('utf8'));
    const profiles = record.installed?.profiled;
    if (
        record.version !== 1 ||
        record.measurementOnly !== true ||
        record.performanceAccepted !== false ||
        !/^[a-f0-9]{40}$/.test(record.sourceCommit) ||
        !Array.isArray(record.qualificationApks) ||
        !Array.isArray(profiles) ||
        profiles.length === 0
    )
        throw new Error('Expected pinned measurement-only renderer profiles');

    const apkBytes = readFileSync(apk);
    const apkSha256 = hash(apkBytes);
    const pinnedApk = record.qualificationApks.find(item => basename(item.path) === basename(apkPathInReport));
    if (pinnedApk?.sha256 !== apkSha256) throw new Error('Qualification APK hash differs from the measurement pin');

    const attribution = JSON.parse(readFileSync(mapPinsPath, 'utf8'));
    if (
        attribution.version !== 1 ||
        attribution.manifestSha256 !== manifestSha256 ||
        attribution.qualificationApkSha256 !== apkSha256 ||
        !Array.isArray(attribution.mappedAssets)
    )
        throw new Error('Source map pins must identify the archived manifest and qualification APK');
    const mapPins = new Map(attribution.mappedAssets.map(pin => [pin.name, pin]));
    if (mapPins.size !== attribution.mappedAssets.length) throw new Error('Duplicate renderer source map pins');

    const assets = realpathSync.native(resolve(build, 'assets'));
    verifyBuildCheckout(assets);
    const javaScript = verifiedJavaScript(apkBytes, assets);
    const loadedMaps = new Map();
    const loadAsset = name => {
        if (!javaScript.has(name)) throw new Error('Frame asset is missing from the qualification APK: ' + name);
        if (!loadedMaps.has(name)) {
            const pin = mapPins.get(name);
            if (pin?.javaScriptSha256 !== javaScript.get(name).sha256)
                throw new Error('Source map pin must identify the verified JavaScript: ' + name);
            const mapBytes = readFileSync(join(assets, name + '.map'));
            const sha256 = hash(mapBytes);
            if (sha256 !== pin.sourceMapSha256)
                throw new Error('Source map hash differs from the attribution pin: ' + name);
            loadedMaps.set(name, { map: JSON.parse(mapBytes.toString('utf8')), sha256 });
        }
        return { code: javaScript.get(name).code, map: loadedMaps.get(name).map };
    };
    const resolveSource = source => {
        if (isAbsolute(source) || /[:\0]/.test(source)) return null;
        const sourcePath = resolve(assets, source);
        const path = repositoryPath(sourcePath);
        if (!path || !statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) return null;
        return { path, text: readFileSync(sourcePath, 'utf8') };
    };

    const captures = profiles.map(({ evidence, report }) => {
        verifyRendererRunReport(report, evidence.json);
        if (
            report.outcome !== 'pass' ||
            report.reports.length !== 1 ||
            report.reports[0].rendererProfile !== true ||
            !report.apks.some(item => item.path === apkPathInReport && item.sha256 === apkSha256)
        )
            throw new Error('Renderer run does not identify the pinned qualification APK and completed case');
        const archived = readFileSync(resolve(root, evidence.compressedTrace.path));
        const { capture, rawTraceSha256 } = verifyRendererTrace(archived, evidence);
        const replayed = analyseRendererTrace(capture, report.reports[0]);
        if (!isDeepStrictEqual(replayed, report.rendererProfile))
            throw new Error('Replayed renderer analysis differs from the measurement pin');
        const frames = mapRendererFrames(replayed.cpu.topFrames, { loadAsset, resolveSource });
        const mapped = frames.reduce((sum, frame) => sum + (frame.original ? frame.samples : 0), 0);
        return {
            api: report.api,
            pageSize: report.pageSize,
            rawTraceSha256,
            renderer: replayed.renderer,
            selected: replayed.selected,
            samples: { total: replayed.cpu.samples, mapped, unmapped: replayed.cpu.samples - mapped },
            frames,
        };
    });

    const result = {
        version: 1,
        measurementOnly: true,
        performanceAccepted: false,
        measurementSourceCommit: record.sourceCommit,
        manifestSha256,
        qualificationApkSha256: apkSha256,
        matchedJavaScriptAssets: javaScript.size,
        mappedAssets: [...loadedMaps.keys()].sort().map(name => ({
            name,
            javaScriptSha256: javaScript.get(name).sha256,
            sourceMapSha256: loadedMaps.get(name).sha256,
        })),
        captures,
    };
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        process.stderr.write('Renderer frame attribution: ' + error.message + '\n');
        process.exitCode = 1;
    }
}
