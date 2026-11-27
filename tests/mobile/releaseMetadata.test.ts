import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(file, 'utf8');

// The version shape the installed app reads from the release catalog: three
// components, each 0 or a non-zero digit with up to nine more digits. A
// version outside that shape is a release the app never discovers.
const RELEASE_VERSION = /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})$/;
// The catalog parses each component as a 32-bit int, so 2147483647 is the
// largest component it reads.
const MAX_RELEASE_COMPONENT = 2147483647;

function readVersion(file: string) {
    const { versionName, versionCode }: { versionName?: unknown; versionCode?: unknown } = JSON.parse(read(file)) ?? {};
    if (typeof versionName !== 'string' || !RELEASE_VERSION.test(versionName))
        throw new Error(`${file}: expected versionName as X.Y.Z, got ${versionName}`);
    for (const component of versionName.split('.')) {
        if (Number(component) > MAX_RELEASE_COMPONENT)
            throw new Error(
                `${file}: expected versionName components at most ${MAX_RELEASE_COMPONENT}, got ${versionName}`,
            );
    }
    if (typeof versionCode !== 'number' || !Number.isSafeInteger(versionCode) || versionCode < 1)
        throw new Error(`${file}: expected a positive integer versionCode, got ${versionCode}`);
    return { versionName, versionCode };
}

const version = readVersion('mobile/version.json');
const release = 'https://github.com/SweetSophia/hrt-tracker-mobile/releases';
const apk = `${release}/download/android-v${version.versionName}/hrt-tracker-${version.versionName}.apk`;
const tag = `${release}/tag/android-v${version.versionName}`;
const notes = `docs/releases/android-${version.versionName}.md`;
const verification = `docs/releases/android-${version.versionName}-verification.md`;

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

    it('keeps the Android version name and version code moving forward', ({ skip }) => {
        const file = process.env.HRT_ANDROID_BASE_VERSION_FILE;
        if (!file) return skip('No predecessor supplied');
        const previous = readVersion(file);
        if (version.versionName === previous.versionName && version.versionCode === previous.versionCode)
            return skip('Android version name and code are unchanged');
        // The name decides which release the installed app discovers in its
        // catalog, the code decides whether Android accepts this APK over the
        // installed one.
        expect(
            version.versionName.localeCompare(previous.versionName, 'en', { numeric: true }),
            `Android version name must not go backwards (previous ${previous.versionName}, current ${version.versionName})`,
        ).toBeGreaterThanOrEqual(0);
        expect(
            version.versionCode,
            `Android versionCode must increase for this release (previous ${previous.versionCode}, current ${version.versionCode})`,
        ).toBeGreaterThan(previous.versionCode);
    });
});
