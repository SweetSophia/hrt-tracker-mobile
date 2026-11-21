import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const outDir = await mkdtemp(join(tmpdir(), 'hrt-upstream-model-'));
try {
    await build({
        configFile: 'vite.mobile.config.ts',
        logLevel: 'silent',
        build: { ssr: 'mobile/probe/upstreamReference.ts', outDir },
    });
    await writeFile(join(outDir, 'package.json'), '{"type":"module"}\n');
    const { upstreamReference } = await import(pathToFileURL(join(outDir, 'upstreamReference.js')).href);
    console.log(JSON.stringify(upstreamReference(), null, 2));
} finally {
    await rm(outDir, { recursive: true, force: true });
}
