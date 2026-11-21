import { expect, test } from '@playwright/test';
import { installForecastReference } from './forecast-reference';
import { DEFAULT_PK_PARAMS } from '../../src/domain/engine';
import { seedStorage } from '../helpers';
import { observeWorkers, resultCount, seed } from './worker-fixture';

for (const mode of ['transfem', 'transmasc']) {
    test(`ordinary Forecast uses the shared worker and exact complete batches (${mode})`, async ({ page, context }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await seedStorage(context, {
            ...seed(),
            'hrt-pk-params': JSON.stringify({ ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 }),
        });
        await observeWorkers(page);
        await installForecastReference(page);
        await page.goto('/');
        if (mode === 'transmasc') {
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await page.getByRole('button', { name: /HRT mode/i }).click();
            await page.getByRole('button', { name: /Masculinizing HRT/i }).click();
            await page.getByRole('button', { name: 'Overview', exact: true }).click();
        }
        await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
        await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'What-if', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.screenWorkerTest.forecastResults.length)).toBeGreaterThan(0);
        await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
        const observed = await page.evaluate(() => window.screenWorkerTest.forecastResults[0]);
        const modelId = await page.evaluate(() => window.screenWorkerTest.modelWorkerIds.at(-1));
        expect(observed.workerId).toBe(modelId);
        expect(observed.input.request.input.isTransmasc).toBe(mode === 'transmasc');
        expect(observed.input.request.input.events[0].id).toBe(mode === 'transmasc' ? 'synthetic-m' : 'synthetic-f');
        if (mode === 'transfem') expect(observed.input.request.pkParams!.e2_oral_bio).toBe(0.08);
        const expected = await page.evaluate(task => {
            const clock = Date.now;
            Date.now = () => task.nowMs;
            try {
                return window.ForecastReference.projectForecast(task.request, new Map());
            } finally {
                Date.now = clock;
            }
        }, observed.input);
        expect(observed.output).toEqual(expected);
        expect(await page.locator('svg[role="img"] path[stroke-dasharray="5 3"]').getAttribute('d')).toMatch(/^M/);
        expect(errors).toEqual([]);
    });
}

test('held Forecast work leaves the editor live and cannot publish the superseded draft', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { holdForecast: true });
    await page.goto('/');
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.screenWorkerTest.forecastRequests.length)).toBeGreaterThan(0);
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('spinbutton', { name: /Dose/ }).fill('7');
    await page.getByRole('tab', { name: '12 wk', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.screenWorkerTest.forecastRequests.length)).toBeGreaterThan(1);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    const latest = await page.evaluate(() => window.screenWorkerTest.forecastResults.at(-1)!);
    expect(latest.input.request.plans[0].spec!.doseMG).toBe(7);
    expect(latest.input.request.input.horizonH).toBe(12 * 7 * 24);
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
    await expect(page.getByRole('tab', { name: '12 wk', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a held former-mode Forecast cannot replace the new mode', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { holdForecast: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.screenWorkerTest.forecastRequests.length)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /HRT mode/i }).click();
    await page.getByRole('button', { name: /Masculinizing HRT/i }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.screenWorkerTest.forecastRequests.at(-1)?.request.input.isTransmasc))
        .toBe(true);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    const results = await page.evaluate(() => window.screenWorkerTest.forecastResults);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(result => result.input.request.input.isTransmasc)).toBe(true);
});

test('Forecast worker failure has a local retry and retains Plan B and its horizon', async ({
    page,
    context,
}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await page.getByRole('button', { name: 'Add plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Plan B', exact: true }).click();
    await page.getByRole('spinbutton', { name: /Dose/ }).fill('7');
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => {
        window.screenWorkerTest.failForecast = true;
    });
    await page.getByRole('tab', { name: '12 wk', exact: true }).click();
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('tab', { name: 'Plan B', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('forecast-worker-error.png') });
    await page.evaluate(() => {
        window.screenWorkerTest.failForecast = false;
    });
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).click();
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
    await expect(page.getByRole('tab', { name: '12 wk', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.main-view').evaluate(node => (node.scrollTop = 0));
    await page.screenshot({ path: testInfo.outputPath('forecast-worker-ready.png') });
});
