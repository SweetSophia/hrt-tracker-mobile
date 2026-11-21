# Web upstream sync log

## Incorporated baseline

The public history starts directly from upstream commit `de7fd0701dcb2e2feaf1a57b4529572e9d1374b6` of [Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker), fully incorporated, with the reviewed Android source snapshot added on top; earlier private rehearsal records are not published. The marker in [`upstream.lock.json`](../../upstream.lock.json) tracks the latest fully incorporated commit and currently holds that commit. Its schema version describes the Android record database (`PRAGMA user_version`), independent of the app version in [`mobile/version.json`](../../mobile/version.json).

The shared UI and model still follow the web source layout. The mobile build adds a Capacitor host, record and document adapters, lifecycle handling, and worker-backed computations. Preserve these boundaries when resolving shared-file changes.

## Review an update

In a fresh mobile clone, configure the primary web remote with `git remote add web-upstream https://github.com/xunxunProjects/Oyama-s-HRT-Tracker.git`. From a checkout with the full Git history, fetch the remote and generate the report.

Run these examples in the same POSIX shell. On Windows, use WSL with Linux Git, Node, and npm for the rehearsal.

```sh
without_repo_overrides() (
  git_vars=$(git rev-parse --local-env-vars) || exit 1
  for git_var in $git_vars; do unset "$git_var" || exit 1; done
  export GIT_NO_REPLACE_OBJECTS=1
  "$@"
)

report=$(mktemp) &&
  without_repo_overrides git fetch web-upstream +refs/heads/main:refs/remotes/web-upstream/main &&
  without_repo_overrides node scripts/mobile/check-upstream.mjs > "$report" &&
  cat "$report"
```

The report reads the lock from the mobile `HEAD` commit and compares committed trees. Each upstream path has its Git status, the mobile status at the same path if it changed, and review areas inferred from the path. Renames appear as a removal and an addition. The report stops if a changed pathname cannot be represented as UTF-8.

Pass a commit or branch as the sole argument to inspect a pinned or synthetic candidate. For example, add `de7fd07` to the report command after fetching its history. An explicit candidate is a local Git revision. Check its source before accepting it as upstream.

After the report command succeeds, use Git 2.38 or newer to preview its two commits. Git exits with status 1 when this preview finds conflicts. Use the same commits for the integration rehearsal even if another fetch moves the tracking ref.

```sh
mobile_commit=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).mobileCommit' "$report") &&
  candidate_commit=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).candidateCommit' "$report") &&
  without_repo_overrides git merge-tree --write-tree --name-only --messages "$mobile_commit" "$candidate_commit"
```

Select the Node version in [`.node-version`](../../.node-version). Each rehearsal gets a new branch and a private directory for the worktree and snapshots. The fixture uses literal lab observations, a frozen clock, and neutral, adult-age, under-19, and weight cases.

```sh
in_rehearsal() (
  cd "$rehearsal" || exit 1
  test "$(git rev-parse --show-toplevel)" = "$rehearsal" || exit 1
  test "$(git symbolic-ref --short HEAD)" = "$rehearsal_branch" || exit 1
  "$@"
)

require_clean() {
  worktree_status=$(git status --porcelain --untracked-files=all) &&
    test -z "$worktree_status"
}

capture_model() {
  node scripts/mobile/capture-upstream-model.mjs > "$1" &&
    node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!s.inputs || !s.results?.length) process.exit(1)' "$1"
}

begin_rehearsal() {
  test "$(git rev-parse HEAD)" = "$mobile_commit" &&
    require_clean &&
    npm ci &&
    require_clean &&
    capture_model "$rehearsal_files/model-before.json" &&
    git merge --no-ff --no-edit "$candidate_commit"
}

rehearsal_files=$(mktemp -d) &&
  rehearsal_files=$(cd "$rehearsal_files" && pwd -P) &&
  candidate_short=$(without_repo_overrides git rev-parse --short "$candidate_commit") &&
  rehearsal_branch="sync/web-$candidate_short-$(basename "$rehearsal_files")" &&
  rehearsal="$rehearsal_files/checkout" &&
  without_repo_overrides git worktree add -b "$rehearsal_branch" "$rehearsal" "$mobile_commit" &&
  without_repo_overrides in_rehearsal begin_rehearsal
```

The block stops if worktree creation, setup, or baseline capture fails. If the merge reports conflicts, edit the files under `$rehearsal`. From the original shell, use the guarded commands to inspect and stage the resolutions. Substitute the paths you resolved for the example below.

```sh
without_repo_overrides in_rehearsal git status --short
without_repo_overrides in_rehearsal git add -- src/App.tsx
```

After staging every resolution, inspect the staged changes for conflict markers and accidental whitespace. The check also flags intentional formatting such as Markdown hard breaks.

```sh
without_repo_overrides in_rehearsal git diff --cached --check
```

Review the diagnostics and correct unintended changes. Re-stage the corrected files using the guarded `git add` above, then repeat the staged check. Once only intentional formatting remains, verify that tracked files match the index and commit the merge in the same worktree.

```sh
without_repo_overrides in_rehearsal git diff --exit-code &&
  without_repo_overrides in_rehearsal git commit --no-edit
```

Before reinstalling dependencies and building the merged code, review dependency, build, and workflow changes. From the original shell, compare the snapshots using the same fixture and capture code.

```sh
require_pinned_merge() {
  git merge-base --is-ancestor "$mobile_commit" HEAD &&
    git merge-base --is-ancestor "$candidate_commit" HEAD
}

capture_merged_model() {
  require_pinned_merge &&
    git diff --exit-code "$mobile_commit" HEAD -- \
      mobile/probe/upstreamReference.ts scripts/mobile/capture-upstream-model.mjs &&
    require_clean &&
    npm ci &&
    require_clean &&
    capture_model "$rehearsal_files/model-after.json"
}

without_repo_overrides in_rehearsal capture_merged_model &&
  diff -u "$rehearsal_files/model-before.json" "$rehearsal_files/model-after.json"
```

Review numerical differences against the upstream rationale. Review record and migration changes against the mobile adapters. Run backup checks and installed Android checks for affected boundaries. The following tests check the report and compare model behavior within the current checkout. Advance the recorded commit only after accepting the full upstream range.

```sh
validate_rehearsal() {
  require_pinned_merge &&
    require_clean &&
    npm run test:mobile:upstream-policy &&
    npm test -- tests/mobile/buildConfig.test.ts tests/mobile/engineParity.test.ts &&
    npm run test:e2e:install &&
    npm run test:e2e:mobile -- e2e/mobile/worker-screens.spec.ts --grep 'accepted result matches the engine'
}

without_repo_overrides in_rehearsal validate_rehearsal
```

For the Git policy tests in native Windows PowerShell, set `$env:HRT_UPSTREAM_POLICY = '1'` and run `npm test -- tests/mobile/upstreamPolicy.test.ts`.

Once the rehearsal is clean and you have saved any evidence you need, run `without_repo_overrides git worktree remove "$rehearsal"` from the original checkout. The uniquely named branch retains the rehearsal commits.

## Selective changes

No selective upstream commits have been recorded since the baseline. When taking a single fix, use `git cherry-pick -x` and record its source SHA, the local commit, and the reason here. Leave the fully incorporated marker at the last accepted merge.
