import { expect, test } from '@playwright/test';
import { seedStorage } from '../helpers';
import { observeWorkers, resultCount, seed } from './worker-fixture';

test('an unavailable worker leaves plan editing, logging and undo usable', async ({ page, context }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 390, height: 740 });
    await seedStorage(context, {
        ...seed(),
        'hrt-plan': JSON.stringify([
            {
                id: 'synthetic-plan',
                route: 'oral',
                ester: 'E2',
                doseMG: 2,
                extras: {},
                everyDays: 1,
                timesPerDay: 1,
            },
        ]),
    });
    await observeWorkers(page, { fail: true });
    await page.goto('/');
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    await expect(page.getByRole('button', { name: /Add a drug/ })).toBeVisible();
    await page.getByRole('button').filter({ hasText: /2 mg/ }).click();
    await page.getByRole('spinbutton', { name: /Dose/ }).fill('3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-plan') ?? '[]')[0]?.doseMG))
        .toBe(3);
    await page.getByRole('button', { name: /Medication plan.*Back/ }).click();
    await expect(page.getByRole('button', { name: 'Medication plan', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Took it', exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]').length)).toBe(2);
    await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]').at(-1)?.doseMG))
        .toBe(3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]').length)).toBe(1);
});

test('saving a Forecast template preserves every scenario and the chosen horizon', async ({ page, context }) => {
    test.setTimeout(30_000);
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.goto('/');
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await page.getByRole('button', { name: 'Add plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Plan B', exact: true }).click();
    await page.getByRole('spinbutton', { name: /Dose/ }).fill('7');
    await page.getByRole('tab', { name: '12 wk', exact: true }).click();
    await page.getByRole('button', { name: 'Save as template', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-dose-templates') ?? '[]').length))
        .toBe(1);
    await expect(page.getByRole('tab', { name: 'Plan B', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
    await expect(page.getByRole('tab', { name: '12 wk', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Plan A', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).not.toHaveValue('7');
});

test('a held minute refresh preserves the Overview scroll position', async ({ page, context }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 390, height: 640 });
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.clock.install();
    await page.goto('/');
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    const pane = page.locator('.main-view');
    const before = await pane.evaluate(node => {
        node.scrollTop = 300;
        return node.scrollTop;
    });
    expect(before).toBeGreaterThan(100);
    const count = await resultCount(page);
    await page.evaluate(() => {
        window.screenWorkerTest.hold = true;
    });
    await page.clock.fastForward(60_000);
    await page.clock.runFor(40);
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    expect(await pane.evaluate(node => node.scrollTop)).toBeGreaterThan(before - 2);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect.poll(() => resultCount(page)).toBeGreaterThan(count);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect
        .poll(() => pane.evaluate((node, previous) => Math.abs(node.scrollTop - previous), before))
        .toBeLessThan(2);
});

test('Forecast keeps drafts but stops announcing calculation after worker failure', async ({ page, context }) => {
    test.setTimeout(30_000);
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.clock.install();
    await page.goto('/');
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await page.getByRole('button', { name: 'Add plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Plan B', exact: true }).click();
    await page.getByRole('spinbutton', { name: /Dose/ }).fill('7');
    await page.getByRole('tab', { name: '12 wk', exact: true }).click();
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => {
        window.screenWorkerTest.failMethod = 'ou_kalman';
    });
    await page.clock.fastForward(60_000);
    await page.clock.runFor(40);
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Plan B', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
    await expect(page.getByRole('tab', { name: '12 wk', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByText('Calculating…', { exact: true })).toHaveCSS('opacity', '0');
    await page.evaluate(() => {
        window.screenWorkerTest.failMethod = undefined;
    });
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).click();
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('tab', { name: 'Plan B', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('spinbutton', { name: /Dose/ })).toHaveValue('7');
});
