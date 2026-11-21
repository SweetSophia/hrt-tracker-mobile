import { expect, test } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

test('cancelling another drug after the first save returns to the plan list', async ({ page, context }, testInfo) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    await page.getByRole('button', { name: 'Oral', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Which drug?', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'How much each time?', exact: true }).fill('2');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const planHeader = page.getByRole('button', { name: /Medication plan.*Back/ });
    await expect(planHeader).toBeVisible();
    await page.getByRole('button', { name: 'Add a drug', exact: true }).click();
    await page.getByRole('button', { name: /Add a drug.*Back/ }).click();
    await expect(planHeader).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-plan') ?? '[]'))).toEqual([
        expect.objectContaining({ route: 'oral', ester: 'EV', doseMG: 2 }),
    ]);
    await page.screenshot({ path: testInfo.outputPath('plan-list-after-cancel.png') });
});
