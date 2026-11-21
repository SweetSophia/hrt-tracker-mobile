import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const baseline = '05f552c4999ea2ba2b996de25ac856d3b4e84890';
// A reference must not silently bless changes to the web model.
execFileSync('git', ['diff', '--exit-code', baseline, '--', 'src/domain', 'logic.ts', 'shbg.ts']);
const output = await mkdtemp(join(tmpdir(), 'hrt-reference-'));
try {
    await build({ configFile: false, build: { ssr: 'mobile/probe/reference.ts', outDir: output, minify: false } });
    const { modelReference, longHistory } = await import(pathToFileURL(join(output, 'reference.js')).href);
    await writeFile(
        'tests/fixtures/mobile/feasibility.json',
        JSON.stringify(
            { baseline, longHistorySampleCount: longHistory().timeH.length, reference: modelReference() },
            null,
            2,
        ) + '\n',
    );
} finally {
    await rm(output, { recursive: true, force: true });
}
