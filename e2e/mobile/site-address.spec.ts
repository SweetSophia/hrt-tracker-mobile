import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage } from '../helpers';

test('the mobile app uses the space above the content for the safe area only', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedStorage(context, baseStorage({ 'app-hide-site-label': 'false', 'app-dev-mode': 'true' }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
    const hostname = new URL(page.url()).hostname;
    await expect(page.getByText(hostname, { exact: true })).toHaveCount(0);
    // This browser viewport has no top safe-area inset.
    await expect.poll(() => page.locator('.main-view').evaluate(node => node.getBoundingClientRect().top)).toBe(0);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^About\b/ }).click();
    await expect(page.getByRole('switch', { name: 'Developer mode' })).toBeChecked();
    await expect(page.getByText('Hide site address', { exact: true })).toHaveCount(0);
});
