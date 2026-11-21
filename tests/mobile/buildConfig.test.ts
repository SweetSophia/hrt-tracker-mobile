import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, UserConfig } from 'vite';
import { createAppConfig } from '../../vite.config';

const files: string[] = [];
const config = (target: 'web' | 'mobile', mode = 'production') => createAppConfig(target)({ command: 'build', mode });
const pluginNames = (value: UserConfig) =>
    ((value.plugins as unknown[]).flat(Infinity) as Plugin[]).filter(Boolean).map(plugin => plugin.name);
const commonDefines = (value: UserConfig) =>
    Object.fromEntries(Object.entries(value.define ?? {}).filter(([key]) => key !== '__HRT_BUILD_TARGET__'));

afterEach(() => {
    vi.unstubAllEnvs();
    for (const file of files.splice(0)) unlinkSync(file);
});

describe('web/mobile build boundary', () => {
    it('keeps common React, resolution, and development-server configuration together', () => {
        vi.stubEnv('VITE_API_ORIGIN', '');
        const web = config('web');
        const mobile = config('mobile');
        expect(pluginNames(web)).toContain('vite:react-babel');
        expect(pluginNames(mobile)).toContain('vite:react-babel');
        expect(pluginNames(mobile).filter(name => name !== 'hrt:mobile-content-policy')).toEqual(
            pluginNames(web).filter(name => !/^vite-plugin-pwa(?::|$)/.test(name)),
        );
        expect(commonDefines(mobile)).toEqual(commonDefines(web));
        expect(mobile.resolve).toEqual(web.resolve);
        expect(mobile.server).toEqual(web.server);
        expect(web.server?.proxy?.['/api']).toMatchObject({ target: 'http://127.0.0.1:8787' });
        expect(mobile.define?.__HRT_BUILD_TARGET__).toBe('"mobile"');
        expect(web.define?.__HRT_BUILD_TARGET__).toBe('"web"');
    });

    it('retains web PWA support while placing mobile assets in their own output', () => {
        vi.stubEnv('VITE_API_ORIGIN', '');
        const web = config('web');
        const mobile = config('mobile');
        expect(pluginNames(web)).toContain('vite-plugin-pwa');
        expect(pluginNames(mobile).some(name => name.includes('pwa'))).toBe(false);
        expect(web.build?.outDir ?? 'dist').toBe('dist');
        expect(mobile.build?.outDir).toBe('dist-mobile');
        expect(mobile.base).toBe('/');
        expect(pluginNames(mobile)).toContain('hrt:mobile-content-policy');
    });

    it('rejects inherited process origins for mobile without changing web configuration', () => {
        vi.stubEnv('VITE_API_ORIGIN', 'https://example.invalid');
        expect(() => config('mobile')).toThrow(/VITE_API_ORIGIN/);
        expect(() => config('web')).not.toThrow();
    });

    it('rejects an origin loaded from a mode-specific environment file', () => {
        vi.stubEnv('VITE_API_ORIGIN', undefined);
        const mode = `mobile-policy-${randomUUID()}`;
        const file = resolve(`.env.${mode}.local`);
        writeFileSync(file, 'VITE_API_ORIGIN=https://example.invalid\n', { flag: 'wx' });
        files.push(file);
        expect(() => config('mobile', mode)).toThrow(/VITE_API_ORIGIN/);
    });

    it.each(['', '   '])('accepts an empty effective origin (%j)', origin => {
        vi.stubEnv('VITE_API_ORIGIN', origin);
        expect(() => config('mobile')).not.toThrow();
    });
});

it('selects native records separately from the storage qualification harness', () => {
    vi.stubEnv('VITE_API_ORIGIN', '');
    const qualification = config('mobile', 'mobile-storage-qualification');
    expect(qualification.define?.__HRT_NATIVE_RECORDS__).toBe('true');
    expect(qualification.define?.__HRT_STORAGE_QUALIFICATION__).toBe('true');
    const beta = config('mobile', 'mobile-offline-beta');
    expect(beta.define?.__HRT_NATIVE_RECORDS__).toBe('true');
    expect(beta.define?.__HRT_STORAGE_QUALIFICATION__).toBe('false');
    expect(beta.build?.outDir).toBe('dist-mobile-offline-beta');
    for (const [target, mode] of [
        ['web', 'production'],
        ['web', 'mobile-storage-qualification'],
        ['web', 'mobile-offline-beta'],
        ['mobile', 'production'],
        ['mobile', 'mobile-probe'],
    ] as const) {
        expect(config(target, mode).define).toMatchObject({
            __HRT_NATIVE_RECORDS__: 'false',
            __HRT_STORAGE_QUALIFICATION__: 'false',
        });
    }
});
