import { expect, test } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

test('the narrow web layout keeps the site address preference', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedStorage(context, baseStorage({ 'app-dev-mode': 'true' }));
    await gotoApp(page);
    const address = page.getByText(new URL(page.url()).hostname, { exact: true });
    await expect(address).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^About\b/ }).click();
    await page.getByRole('switch', { name: 'Hide site address', exact: true }).click();
    await expect(address).toBeHidden();
});
