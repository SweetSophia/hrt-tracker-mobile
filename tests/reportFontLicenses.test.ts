import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from '../src/reports/fonts/manifest.json';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('distributed PDF font licences', () => {
    it.each([
        ['LICENSE.txt', 'noto-sans-OFL-1.1.txt', 'Copyright 2022 The Noto Project Authors'],
        ['LICENSE-CJK.txt', 'noto-sans-cjk-OFL-1.1.txt', "Reserved Font Name 'Source'"],
    ])('ships the matching %s', (sourceName, publicName, notice) => {
        const source = read(`../src/reports/fonts/${sourceName}`);
        expect(source).toContain(notice);
        expect(read(`../public/licenses/${publicName}`)).toBe(source);
    });

    it('ships the generated notice for the same pinned source as the manifest', () => {
        const template = read('../src/reports/fonts/THIRD-PARTY-NOTICES.txt');
        const notice = read('../public/licenses/THIRD-PARTY-NOTICES.txt');
        expect(notice).toBe(template.replace('{{COMMIT}}', manifest.upstream.commit));
        expect(notice).not.toContain('{{COMMIT}}');
        expect(notice).toContain('noto-sans-cjk-OFL-1.1.txt');
    });
});
