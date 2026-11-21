import type { Page } from '@playwright/test';
import { build } from 'vite';
import type { ForecastProjection, ForecastRequest } from '../../src/application/forecastProjection';

declare global {
    interface Window {
        ForecastReference: {
            projectForecast(request: ForecastRequest, cache: Map<string, unknown>): ForecastProjection;
        };
    }
}
let bundle: Promise<string> | undefined;

/** Test-only oracle in the same JS engine; no asset or hook is added to the app. */
export async function installForecastReference(page: Page) {
    bundle ??= (async () => {
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            build: {
                write: false,
                emptyOutDir: false,
                minify: false,
                target: 'es2022',
                lib: { entry: 'src/application/forecastProjection.ts', name: 'ForecastReference', formats: ['iife'] },
            },
        });
        const output = Array.isArray(result) ? result[0] : result;
        if (!('output' in output)) throw new Error('Reference build did not produce a bundle');
        const chunk = output.output.find(file => file.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw new Error('Missing reference script');
        return chunk.code;
    })();
    await page.addInitScript({ content: `${await bundle}\nwindow.ForecastReference = ForecastReference;` });
}
