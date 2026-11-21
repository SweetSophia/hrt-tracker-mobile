import type { Page } from '@playwright/test';
import { build } from 'vite';
import type { DemoTaskInput, DemoOutput } from '../../src/application/demoProtocol';
declare global {
    interface Window {
        DemoReference: { projectDemo(input: DemoTaskInput): DemoOutput };
    }
}
let bundle: Promise<string> | undefined;
/** Same-engine transport oracle only; the pre-extraction golden fixtures verify extraction. */
export async function installDemoReference(page: Page) {
    bundle ??= (async () => {
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            build: {
                write: false,
                emptyOutDir: false,
                minify: false,
                target: 'es2022',
                lib: { entry: 'src/application/demoProjection.ts', name: 'DemoReference', formats: ['iife'] },
            },
        });
        const output = Array.isArray(result) ? result[0] : result;
        if (!('output' in output)) throw new Error('Missing reference output');
        const chunk = output.output.find(f => f.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw new Error('Missing reference script');
        return chunk.code;
    })();
    await page.addInitScript({ content: `${await bundle}\nwindow.DemoReference = DemoReference;` });
}
