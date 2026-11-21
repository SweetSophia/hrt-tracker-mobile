#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const defaultCandidate = 'refs/remotes/web-upstream/main';
const pathAreas = {
    model: [
        /^(?:logic|shbg)\.ts$/,
        /^src\/(?:domain\/|application\/(?:engine|forecast|demo)|utils\/(?:pk|model|calibration))/,
        /^src\/utils\/(?:plan|regimen)\.ts$/,
        /^tests\/(?:age|popPK|simulation)\.test\.ts$/,
    ],
    persistence: [
        /^backupPolicy\.ts$/,
        /^android\/native-storage\//,
        /^src\/(?:records|platform)\//,
        /^src\/application\/(?:bootstrap|nativeRuntime|record)/,
        /^src\/hooks\/use(?:AppData|CloudSync)\.ts$/,
        /^src\/utils\/(?:backup|cloudBackup|replaceJournal|replaceTransaction|syncMerge|sync\/)/,
        /^tests\/(?:backup|localHealthData|replaceTransaction)/,
    ],
    ui: [
        /^(?:index\.(?:html|tsx)$|design\/|public\/)/,
        /^src\/(?:App\.tsx|index\.css|hooks\/useAppNavigation\.ts)$/,
        /^src\/(?:assets|components|content|contexts|i18n|pages|routes|styles)\//,
    ],
    api: [
        /^(?:worker|workerUtil|toolApi|contentStore|requestInput|f2f|hrtPairing|communityVoteServer)\.ts$/,
        /^(?:backupPolicy|passwordStrength|shareExpiry|shareSnapshotSchema)\.ts$/,
        /^(?:wrangler\.toml$|migrations\/|hrt-server\/|src\/(?:server|services)\/)/,
        /^src\/hooks\/use(?:CloudSync|LiveShareSync)\.ts$/,
    ],
    dependencies: [/^(?:package(?:-lock)?\.json|\.node-version|src-tauri\/Cargo\.(?:toml|lock))$/],
    build: [
        /^\.dockerignore$/,
        /^(?:vite(?:\.mobile)?|capacitor|playwright|postcss)\.config\.[^.]+$/,
        /^(?:tsconfig(?:\.[^.]+)?\.json|package\.json|Dockerfile|compose\.yaml|src-tauri\/tauri\.conf\.json)$/,
        /^(?:android|docker|scripts\/mobile)\//,
    ],
    workflow: [/^\.github\/(?:workflows\/|dependabot\.yml$)/],
};

function runGit(...args) {
    const result = spawnSync('git', ['--no-replace-objects', ...args], { maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
}

function git(...args) {
    const result = runGit(...args);
    if (result.status !== 0) throw new Error(result.stderr.toString().trim() || `Git ${args[0]} failed`);
    return result.stdout;
}

function commitOf(revision) {
    const result = runGit('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`);
    if (result.status !== 0)
        throw new Error(`Commit unavailable for ${revision}. Fetch the required Git history first.`);
    return result.stdout.toString().trim();
}

function isAncestor(ancestor, descendant) {
    const result = runGit('merge-base', '--is-ancestor', ancestor, descendant);
    if (result.status === 0 || result.status === 1) return result.status === 0;
    throw new Error(result.stderr.toString().trim() || 'Could not verify commit ancestry');
}

function repositoryIdentity(url) {
    return url
        .trim()
        .replace(/^git@github\.com:/i, 'https://github.com/')
        .replace(/^ssh:\/\/git@(?:github\.com(?::22)?|ssh\.github\.com:443)\//i, 'https://github.com/')
        .replace(/\/$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
}

function changedPaths(base, commit) {
    const output = git(
        'diff',
        '--name-status',
        '-z',
        '--no-relative',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        base,
        commit,
        '--',
    );
    let decoded;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
    } catch {
        throw new Error('Git changed-path output contains invalid UTF-8. Inspect the range with Git directly.');
    }
    const fields = decoded.split('\0').slice(0, -1);
    const changes = new Map();
    for (let i = 0; i < fields.length; i += 2) changes.set(fields[i + 1], fields[i]);
    return changes;
}

function createReport(args) {
    if (args.length > 1 || args[0]?.startsWith('-')) {
        throw new Error('Usage: node scripts/mobile/check-upstream.mjs [candidate-ref]');
    }

    const mobileCommit = commitOf('HEAD');
    const lock = JSON.parse(git('cat-file', 'blob', `${mobileCommit}:upstream.lock.json`).toString('utf8'));
    if (
        !lock ||
        typeof lock.repository !== 'string' ||
        !lock.repository.trim() ||
        typeof lock.lastFullyMergedCommit !== 'string' ||
        !/^[0-9a-f]{40}$/.test(lock.lastFullyMergedCommit) ||
        !Number.isSafeInteger(lock.schemaVersion) ||
        lock.schemaVersion < 1
    ) {
        throw new Error(
            'Invalid upstream.lock.json. Expected a repository, a full commit SHA, and a positive schema version.',
        );
    }
    const { repository, lastFullyMergedCommit, schemaVersion } = lock;
    const candidateRef = args[0] ?? defaultCandidate;
    if (args.length === 0) {
        const remote = runGit('remote', 'get-url', 'web-upstream');
        if (remote.status !== 0) throw new Error(`Configure web-upstream for ${repository} and fetch it first.`);
        if (repositoryIdentity(remote.stdout.toString()) !== repositoryIdentity(repository)) {
            throw new Error('web-upstream does not match the locked repository');
        }
    }
    const base = commitOf(lastFullyMergedCommit);
    if (base !== lastFullyMergedCommit) throw new Error('Locked upstream ID must identify a commit');
    const candidateCommit = commitOf(candidateRef);
    if (!isAncestor(base, mobileCommit)) throw new Error('Locked upstream commit is absent from mobile HEAD history');
    if (!isAncestor(base, candidateCommit)) throw new Error(`Candidate does not descend from ${lastFullyMergedCommit}`);

    const mobileChanges = changedPaths(base, mobileCommit);
    const changedFiles = Array.from(changedPaths(base, candidateCommit), ([path, upstreamStatus]) => {
        const areas = Object.keys(pathAreas).filter(area => pathAreas[area].some(pattern => pattern.test(path)));
        return {
            path,
            upstreamStatus,
            mobileStatus: mobileChanges.get(path) ?? null,
            areas: areas.length ? areas : ['other'],
        };
    });
    return {
        repository,
        lastFullyMergedCommit,
        schemaVersion,
        mobileCommit,
        candidateRef,
        candidateCommit,
        candidateInMobileHistory: isAncestor(candidateCommit, mobileCommit),
        commitsAfterMarker: Number(git('rev-list', '--count', `${base}..${candidateCommit}`).toString()),
        changedFiles,
    };
}

try {
    console.log(JSON.stringify(createReport(process.argv.slice(2)), null, 2));
} catch (error) {
    console.error(`Upstream report failed. ${error.message}`);
    process.exitCode = 1;
}
