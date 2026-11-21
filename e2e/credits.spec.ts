import { expect, test } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

test('web Credits retains the upstream developers and contribution links', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await page.getByRole('button', { name: 'Credits', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Developers', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^SweetSophia/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'contributing guide', exact: true })).toHaveAttribute(
        'href',
        'https://github.com/xunxunProjects/Oyama-s-HRT-Tracker/blob/main/CONTRIBUTING.md',
    );
});
