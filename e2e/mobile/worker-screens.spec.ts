import { expect, test } from '@playwright/test';
import { applyPKOverrides, getActivePKParams, runSimulation, computeCalibration } from '../../src/domain/engine';
import { seedStorage } from '../helpers';
import { observeWorkers, resultCount, seed } from './worker-fixture';

test('ordinary mobile screens use exact worker samples and a coherent ticking chart clock', async ({
    page,
    context,
}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.clock.install();
    await page.goto('/');
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    const first = await page.evaluate(() => window.screenWorkerTest.results.at(-1)!);
    expect(first.screen).toBeTruthy();
    expect(first.screen!.sampleTimesH).toContain(first.screen!.nowMs / 3_600_000);
    for (const point of first.calibration.points) expect(first.screen!.sampleTimesH).toContain(point.timeH);
    const estimateInfo = page.getByRole('button', { name: 'Current estimated level', exact: true });
    await estimateInfo.click();
    await expect(estimateInfo).toHaveAttribute('aria-expanded', 'true');
    const range = page.getByRole('tab', { name: '30d', exact: true });
    await range.click();
    await expect(range).toHaveAttribute('aria-selected', 'true');
    const count = await resultCount(page);
    await page.evaluate(() => {
        window.screenWorkerTest.hold = true;
    });
    await page.clock.fastForward(60_000);
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await expect(page.locator('#sidebar-status')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[aria-controls="estimate-explainer"]')).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect.poll(() => resultCount(page)).toBeGreaterThan(count);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    const next = await page.evaluate(() => window.screenWorkerTest.results.at(-1)!);
    expect(next.simulation).toEqual(first.simulation);
    expect(next.screen!.nowMs).toBeGreaterThan(first.screen!.nowMs);
    await expect(estimateInfo).toHaveAttribute('aria-expanded', 'true');
    await expect(range).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Labs', exact: true }).click();
    await page.getByRole('button', { name: /Calibration/ }).click();
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('worker failure has a retry path while records and navigation remain available', async ({
    page,
    context,
}, testInfo) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { fail: true });
    await page.goto('/');
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('worker-error.png') });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add dose', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.evaluate(() => {
        window.screenWorkerTest.fail = false;
    });
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).click();
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('worker-ready.png') });
});

test('a held old-mode computation cannot publish after a mode switch', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedStorage(context, seed());
    await observeWorkers(page, { hold: true });
    await page.goto('/');
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /HRT mode/i }).click();
    await page.getByRole('button', { name: /Masculinizing HRT/i }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.screenWorkerTest.release();
    });
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    const outputs = await page.evaluate(() => window.screenWorkerTest.results);
    expect(outputs.every(output => output.simulation!.concPGmL_E2.every(n => n === 0))).toBe(true);
    expect(outputs.some(output => output.simulation!.concNGdL_T!.some(n => n > 0))).toBe(true);
    expect(errors).toEqual([]);
});

test('phone record settings save while a model is held and the accepted result matches the engine', async ({
    page,
    context,
}, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedStorage(context, seed());
    await observeWorkers(page, { hold: true });
    await page.goto('/');
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button').filter({ hasText: 'General' }).click();
    await page.getByRole('button', { name: /^Weight/ }).click();
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('72');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    const { input, output } = await page.evaluate(() => ({
        input: window.screenWorkerTest.requests.at(-1)!.input,
        output: window.screenWorkerTest.results.at(-1)!,
    }));
    expect(input.weightKG).toBe(72);
    const clock = Date.now;
    const params = getActivePKParams();
    try {
        Date.now = () => input.nowMs;
        applyPKOverrides(input.pkParams);
        const reference = runSimulation(input.events, input.weightKG, input.birthYear)!;
        const calibration = computeCalibration(
            reference,
            input.events,
            input.weightKG,
            input.labs,
            input.calibrationMethod,
            input.historyMode,
            input.birthYear,
        );
        expect(output.simulation!.timeH).toEqual(reference.timeH);
        for (let i = 0; i < reference.timeH.length; i++)
            expect(output.simulation!.concPGmL_E2[i]).toBeCloseTo(reference.concPGmL_E2[i], 8);
        for (let i = 0; i < output.screen!.sampleTimesH.length; i++)
            expect(output.screen!.factors[i]).toBeCloseTo(calibration.factorFn(output.screen!.sampleTimesH[i]), 10);
    } finally {
        applyPKOverrides(params);
        Date.now = clock;
    }
    await page.screenshot({ path: testInfo.outputPath('worker-phone-ready.png') });
});

test('calibration controls remain editable after a method-specific worker failure', async ({ page, context }) => {
    await seedStorage(context, { ...seed(), 'hrt-cal-method': 'mcmc' });
    await observeWorkers(page, { failMethod: 'mcmc' });
    await page.goto('/');
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await page.getByRole('button', { name: 'Labs', exact: true }).click();
    await page.getByRole('button', { name: /Calibration/ }).click();
    await page.getByRole('button', { name: /^Off\b/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-cal-method'))).toBe('off');
    await expect
        .poll(() =>
            page.evaluate(() => window.screenWorkerTest.results.some(result => result.calibration.method === 'off')),
        )
        .toBe(true);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
});
