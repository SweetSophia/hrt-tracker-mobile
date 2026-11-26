import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e/mobile',
    workers: 1,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:4174',
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command:
            'npm run build:mobile && npx vite preview --config vite.mobile.config.ts --host 127.0.0.1 --port 4174 --strictPort',
        url: 'http://127.0.0.1:4174',
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
