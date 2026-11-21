import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e/storage-qualification',
    outputDir: '.e2e/storage-qualification-results',
    workers: 1,
    timeout: 60_000,
    retries: 0,
    reporter: 'list',
    use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4175',
        trace: 'retain-on-failure',
    },
    webServer: {
        command:
            'npm run build:mobile:storage && npx vite preview --config vite.mobile.config.ts --host 127.0.0.1 --port 4175 --strictPort',
        url: 'http://127.0.0.1:4175',
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
