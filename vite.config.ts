import { defineConfig, loadEnv, type UserConfigFnObject } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolveApiOrigin } from './e2e/apiOrigin';
import { mobileContentPolicy } from './scripts/mobile/contentPolicy';

export const createAppConfig =
    (target: 'web' | 'mobile'): UserConfigFnObject =>
    ({ mode }) => {
        const mobile = target === 'mobile';
        const storageQualification = mobile && mode === 'mobile-storage-qualification';
        const offlineBeta = mobile && mode === 'mobile-offline-beta';
        if (mobile && loadEnv(mode, process.cwd(), 'VITE_').VITE_API_ORIGIN?.trim()) {
            throw new Error('Mobile builds require an empty VITE_API_ORIGIN; no remote backend is selected.');
        }
        return {
            ...(mobile
                ? {
                      base: '/',
                      build: { outDir: offlineBeta ? 'dist-mobile-offline-beta' : 'dist-mobile' },
                      preview: { proxy: {} },
                  }
                : {}),
            define: {
                __HRT_BUILD_TARGET__: JSON.stringify(target),
                __HRT_MOBILE_PROBE__: JSON.stringify(mobile && mode === 'mobile-probe'),
                __HRT_NATIVE_RECORDS__: JSON.stringify(storageQualification || offlineBeta),
                __HRT_STORAGE_QUALIFICATION__: JSON.stringify(storageQualification),
            },
            server: {
                port: 3000,
                host: '0.0.0.0',
                proxy: {
                    '/api': {
                        target: resolveApiOrigin(),
                        changeOrigin: true,
                        secure: false,
                    },
                },
            },
            plugins: [
                react(),
                mobile
                    ? mobileContentPolicy()
                    : VitePWA({
                          // A new build waits until the user taps refresh in the update
                          // prompt (src/utils/swUpdate.ts registers the worker itself).
                          registerType: 'prompt',
                          injectRegister: false,
                          includeAssets: ['favicon.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
                          manifest: {
                              name: 'HRT Tracker',
                              short_name: 'HRT Tracker',
                              description: 'Log HRT doses and estimate hormone levels',
                              theme_color: '#FFFFFF',
                              background_color: '#FFFFFF',
                              display: 'standalone',
                              orientation: 'portrait',
                              icons: [
                                  {
                                      src: 'pwa-192x192.png',
                                      sizes: '192x192',
                                      type: 'image/png',
                                      purpose: 'any maskable',
                                  },
                                  {
                                      src: 'pwa-512x512.png',
                                      sizes: '512x512',
                                      type: 'image/png',
                                      purpose: 'any maskable',
                                  },
                              ],
                          },
                          workbox: {
                              // Shared pages require the network API and should always load the
                              // current application shell instead of an older precached shell.
                              navigateFallbackDenylist: [/^\/share(?:\/|$)/],
                          },
                      }),
            ],
        };
    };

export default defineConfig(createAppConfig('web'));
