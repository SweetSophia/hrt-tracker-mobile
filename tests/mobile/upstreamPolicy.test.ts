import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/mobile/check-upstream.mjs', import.meta.url));
const repository = 'https://github.com/xunxunProjects/Oyama-s-HRT-Tracker';
const runPolicy = process.env.HRT_UPSTREAM_POLICY === '1';
const upstreamTest = it.skipIf(!runPolicy);
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'hrt-upstream-'));
    roots.push(directory);
    const root = join(directory, 'repo');
    const config = join(directory, 'gitconfig');
    const empty = join(directory, 'empty');
    const hooks = join(directory, 'hooks');
    mkdirSync(root);
    mkdirSync(hooks);
    writeFileSync(config, '');
    writeFileSync(empty, '');
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
    };
    const gitWithInput = (input: Buffer | undefined, ...args: string[]) =>
        execFileSync(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                '-c',
                'commit.gpgsign=false',
                '-c',
                `core.hooksPath=${hooks}`,
                ...args,
            ],
            { cwd: root, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
    const git = (...args: string[]) => gitWithInput(undefined, ...args);
    const write = (path: string, value: string) => {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, value);
    };
    const commit = (message: string) => {
        git('add', '--all');
        git('commit', '-m', message);
        return git('rev-parse', 'HEAD');
    };
    const lock = (lastFullyMergedCommit: string) =>
        write('upstream.lock.json', JSON.stringify({ repository, lastFullyMergedCommit, schemaVersion: 1 }));

    git('init', '--template=', '--initial-branch=main', '--object-format=sha1');
    git('config', '--local', 'core.excludesFile', empty);
    git('config', '--local', 'core.attributesFile', empty);
    write('src/domain/model.ts', 'base');
    write('src/utils/backupBundle.ts', 'base');
    write('worker.ts', 'base');
    const baseline = commit('Web baseline');
    git('switch', '-c', 'incoming');
    write('.dockerignore', 'new context');
    write('backupPolicy.ts', 'new backup limit');
    write('src/domain/model.ts', 'web model change');
    write('src/pages/New view.tsx', 'new screen');
    write('src/server/routes/example.ts', 'new endpoint');
    write('vite.config.ts', 'new build options');
    write('package-lock.json', '{}');
    write('.github/workflows/ci.yml', 'new workflow');
    write('src/utils/backupBundle.ts', 'new backup fields');
    write('src/utils/regimen.ts', 'new forecast utility');
    write('src/utils/replaceJournal.ts', 'new restore journal');
    rmSync(join(root, 'worker.ts'));
    const candidate = commit('Upstream changes');
    git('remote', 'add', 'web-upstream', `${repository}.git`);
    git('update-ref', 'refs/remotes/web-upstream/main', candidate);
    git('switch', 'main');
    lock(baseline);
    write('src/domain/model.ts', 'mobile model adapter');
    write('android/app/build.gradle', 'native-only configuration');
    const mobile = commit('Mobile changes');
    const report = (args: string[] = [], cwd = root) =>
        spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
    return { root, git, gitWithInput, write, lock, commit, baseline, candidate, mobile, report };
}

upstreamTest('reports every path from a subdirectory and preserves tracked drafts and the index', () => {
    const { root, git, write, baseline, candidate, mobile, report } = fixture();
    const draftPath = 'src/utils/backupBundle.ts';
    write(draftPath, 'staged draft');
    git('add', '--', draftPath);
    const staged = git('rev-parse', `:${draftPath}`);
    write(draftPath, 'unstaged draft');
    git('config', 'diff.relative', 'true');
    const before = git('status', '--porcelain');
    const result = report([], join(root, 'src'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
        repository,
        lastFullyMergedCommit: baseline,
        schemaVersion: 1,
        mobileCommit: mobile,
        candidateRef: 'refs/remotes/web-upstream/main',
        candidateCommit: candidate,
        candidateInMobileHistory: false,
        commitsAfterMarker: 1,
        changedFiles: [
            { path: '.dockerignore', upstreamStatus: 'A', mobileStatus: null, areas: ['build'] },
            { path: '.github/workflows/ci.yml', upstreamStatus: 'A', mobileStatus: null, areas: ['workflow'] },
            { path: 'backupPolicy.ts', upstreamStatus: 'A', mobileStatus: null, areas: ['persistence', 'api'] },
            { path: 'package-lock.json', upstreamStatus: 'A', mobileStatus: null, areas: ['dependencies'] },
            { path: 'src/domain/model.ts', upstreamStatus: 'M', mobileStatus: 'M', areas: ['model'] },
            { path: 'src/pages/New view.tsx', upstreamStatus: 'A', mobileStatus: null, areas: ['ui'] },
            { path: 'src/server/routes/example.ts', upstreamStatus: 'A', mobileStatus: null, areas: ['api'] },
            { path: 'src/utils/backupBundle.ts', upstreamStatus: 'M', mobileStatus: null, areas: ['persistence'] },
            { path: 'src/utils/regimen.ts', upstreamStatus: 'A', mobileStatus: null, areas: ['model'] },
            { path: 'src/utils/replaceJournal.ts', upstreamStatus: 'A', mobileStatus: null, areas: ['persistence'] },
            { path: 'vite.config.ts', upstreamStatus: 'A', mobileStatus: null, areas: ['build'] },
            { path: 'worker.ts', upstreamStatus: 'D', mobileStatus: null, areas: ['api'] },
        ],
    });
    expect(git('status', '--porcelain')).toBe(before);
    expect(git('rev-parse', 'HEAD')).toBe(mobile);
    expect(git('rev-parse', `:${draftPath}`)).toBe(staged);
    expect(readFileSync(join(root, draftPath), 'utf8')).toBe('unstaged draft');
});

upstreamTest('reports an explicit local candidate, including an empty range at the marker', () => {
    const { baseline, report } = fixture();
    const result = report([baseline]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
        candidateRef: baseline,
        candidateCommit: baseline,
        candidateInMobileHistory: true,
        commitsAfterMarker: 0,
        changedFiles: [],
    });
});

upstreamTest('checks the default remote identity and accepts an explicit local revision', () => {
    const { git, candidate, report } = fixture();
    git('remote', 'set-url', 'web-upstream', 'https://github.com/example/another-project');
    const result = report();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('web-upstream does not match the locked repository');
    const explicit = report(['refs/remotes/web-upstream/main']);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout).candidateCommit).toBe(candidate);
});

upstreamTest('accepts the GitHub SSH-over-443 equivalent after URL rewriting', () => {
    const { git, report } = fixture();
    git('config', 'url.ssh://git@ssh.github.com:443/.insteadOf', 'https://github.com/');
    const result = report();
    expect(result.status, result.stderr).toBe(0);
});

upstreamTest('reads the lock from the reported commit even if a staged lock advances the marker', () => {
    const { root, git, lock, baseline, candidate, report } = fixture();
    git('merge', '-s', 'ours', '--no-edit', 'incoming');
    const mobileCommit = git('rev-parse', 'HEAD');
    lock(candidate);
    git('add', '--', 'upstream.lock.json');
    const result = report();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
        mobileCommit,
        lastFullyMergedCommit: baseline,
        commitsAfterMarker: 1,
    });
    expect(JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8')).lastFullyMergedCommit).toBe(candidate);
});

upstreamTest('uses the original commit object when a Git replacement supplies another lock', () => {
    const { git, lock, commit, baseline, candidate, report } = fixture();
    git('merge', '-s', 'ours', '--no-edit', 'incoming');
    const mobileCommit = git('rev-parse', 'HEAD');
    lock(candidate);
    const replacement = commit('Replacement with a different marker');
    git('switch', '--detach', mobileCommit);
    git('replace', mobileCommit, replacement);

    const result = report();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
        mobileCommit,
        lastFullyMergedCommit: baseline,
        commitsAfterMarker: 1,
    });
});

upstreamTest('rejects a candidate and a claimed marker outside their required histories', () => {
    const { git, lock, commit, baseline, candidate, report } = fixture();
    const unrelated = git('commit-tree', `${baseline}^{tree}`, '-m', 'Unrelated root');
    const unrelatedReport = report([unrelated]);
    expect(unrelatedReport.status).toBe(1);
    expect(unrelatedReport.stderr).toContain('Candidate does not descend from');

    lock(candidate);
    commit('Invalid marker');
    const unmergedMarkerReport = report();
    expect(unmergedMarkerReport.status).toBe(1);
    expect(unmergedMarkerReport.stderr).toContain('Locked upstream commit is absent from mobile HEAD history');
});

upstreamTest('rejects an annotated tag object ID in the lock while accepting tags as candidates', () => {
    const { git, lock, commit, baseline, report } = fixture();
    git('tag', '-a', '-m', 'Fixture tag', 'baseline', baseline);
    const explicit = report(['baseline']);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout).candidateCommit).toBe(baseline);

    lock(git('rev-parse', 'refs/tags/baseline'));
    commit('Invalid tag object marker');
    const result = report();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Locked upstream ID must identify a commit');
});

upstreamTest('fails visibly on a pathname with invalid UTF-8 without checking it out', () => {
    const { git, gitWithInput, candidate, report } = fixture();
    const blob = git('rev-parse', `${candidate}:src/domain/model.ts`);
    const tree = gitWithInput(
        Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff, 0])]),
        'mktree',
        '-z',
    );
    const invalidPathCommit = git('commit-tree', tree, '-p', candidate, '-m', 'Raw filename');
    const result = report([invalidPathCommit]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Git changed-path output contains invalid UTF-8');
});
