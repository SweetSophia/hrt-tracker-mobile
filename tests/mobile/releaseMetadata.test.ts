import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Android version the app is built from. Everything the repository
// advertises has to point at this release: the READMEs, both languages of the
// release notes and the APK SHA-256 the verification record confirms.
const version = JSON.parse(readFileSync('mobile/version.json', 'utf8'));
const release = 'https://github.com/SweetSophia/hrt-tracker-mobile/releases';
const apk = `${release}/download/android-v${version.versionName}/hrt-tracker-${version.versionName}.apk`;
const tag = `${release}/tag/android-v${version.versionName}`;
const notes = `docs/releases/android-${version.versionName}.md`;
const verification = `docs/releases/android-${version.versionName}-verification.md`;

const read = (file: string): string => readFileSync(file, 'utf8');
const links = (text: string): string[] => [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
const releaseLinks = (text: string): string[] => links(text).filter(link => link.startsWith(release));
// A second-level section, selected by its heading alone: a release link in
// historical prose or in another section neither satisfies nor fails it.
const section = (text: string, heading: string): string =>
    text.split(/^## /m).find(part => part.split('\n')[0].trim() === heading) ?? '';
// The rows of a Markdown table, with the cell markup removed.
const tableRows = (text: string): string[][] =>
    text
        .split('\n')
        .filter(line => line.trim().startsWith('|'))
        .map(line => line.split('|').map(cell => cell.trim().replace(/`/g, '')));
describe('Android release metadata', () => {
    it.each([
        ['README.md', 'Download for Android'],
        ['README.zh-CN.md', '下载 Android 版'],
    ])('%s advertises the current APK and release tag', (file, heading) => {
        const found = releaseLinks(section(read(file), heading));
        expect(found, `${file} (${heading}) has no release link`).not.toHaveLength(0);
        expect(found, `${file} (${heading}) advertises a stale APK`).toContain(apk);
        expect(found, `${file} (${heading}) advertises a stale release tag`).toContain(tag);
    });

    it.each(['English', '简体中文'])('the %s release notes offer the current APK', heading => {
        const found = releaseLinks(section(read(notes), heading));
        expect(found, `${notes} (${heading}) has no release link`).not.toHaveLength(0);
        expect(found, `${notes} (${heading}) advertises a stale APK`).toContain(apk);
    });

    it('publishes the APK SHA-256 that the verification record verified', () => {
        const published = /\*\*APK SHA-256\*\*\s*`([0-9a-f]{64})`/.exec(read(notes));
        expect(published, `${notes} publishes no APK SHA-256`).not.toBeNull();
        const row = tableRows(read(verification)).find(cells => cells[1] === `hrt-tracker-${version.versionName}.apk`);
        expect(row, `${verification} has no SHA-256 row for the APK`).toBeDefined();
        expect(published?.[1], `${notes} and ${verification} disagree on the APK SHA-256`).toBe(row?.[2]);
    });

    const base = process.env.GITHUB_BASE_SHA;
    it.skipIf(!base)('raises the Android version code when the Android version changes', () => {
        // The checkout carries the base commit, so a missing object is a
        // broken comparison rather than a reason to skip it.
        const previous = JSON.parse(execFileSync('git', ['show', `${base}:mobile/version.json`], { encoding: 'utf8' }));
        if (previous.versionName === version.versionName) return; // Not a release.
        expect(version.versionCode, 'the Android version code has to rise above the base branch').toBeGreaterThan(
            previous.versionCode,
        );
    });
});
