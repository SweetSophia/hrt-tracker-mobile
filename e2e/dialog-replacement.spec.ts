import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage } from './helpers';

test.beforeEach(async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await page.goto('/e2e/fixtures/import-dialogs.html');
});
const counts = (page: import('@playwright/test').Page) =>
    page.evaluate(
        () =>
            (window as unknown as { __importDialogCounts: { cancelled: number; confirmed: number } })
                .__importDialogCounts,
    );

test('superseding a file confirmation settles cancellation and releases all import actions', async ({ page }) => {
    const file = page.getByRole('button', { name: 'Select JSON file', exact: false });
    const chooser = page.waitForEvent('filechooser');
    await file.click();
    await (await chooser).setFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await expect(page.locator('[data-prompt="confirm"]')).toContainText('Synthetic import preview');
    await expect(file).toBeDisabled();
    await page.getByRole('button', { name: 'Unrelated prompt', exact: true }).click();
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Unrelated operation message');
    await expect(file).toBeEnabled();
    await expect(
        page.getByRole('button', { name: 'Replace this device from a complete backup', exact: false }),
    ).toBeEnabled();
    await expect.poll(() => counts(page)).toEqual({ cancelled: 1, confirmed: 0 });
    await page.getByRole('button', { name: 'Dismiss old prompt' }).click();
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Unrelated operation message');
    expect(await counts(page)).toEqual({ cancelled: 1, confirmed: 0 });
});

test('a cancellation callback may open a follow-up without a stale close removing it', async ({ page }) => {
    await page.getByRole('button', { name: 'Reentrant confirmation', exact: true }).click();
    await page.getByRole('button', { name: 'Unrelated prompt', exact: true }).click();
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Cancellation follow-up');
    await page.getByRole('button', { name: 'Dismiss old prompt' }).click();
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Cancellation follow-up');
    expect(await counts(page)).toEqual({ cancelled: 1, confirmed: 0 });
});

test('replacing an alert never runs its acknowledgement action', async ({ page }) => {
    await page.getByRole('button', { name: 'Alert with callback', exact: true }).click();
    await page.getByRole('button', { name: 'Unrelated prompt', exact: true }).click();
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Unrelated operation message');
    expect(await counts(page)).toEqual({ cancelled: 0, confirmed: 0 });
});

for (const attribute of ['inert', 'hidden']) {
    test(`a retained ${attribute} prompt host cancels once without confirming`, async ({ page }) => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Select JSON file', exact: false }).click();
        await (
            await chooser
        ).setFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
        const prompt = page.locator('[data-prompt="confirm"]');
        await expect(prompt).toBeVisible();
        await prompt.evaluate((line, attr) => line.parentElement!.setAttribute(attr, ''), attribute);
        await expect(prompt).toHaveCount(0);
        await expect.poll(() => counts(page)).toEqual({ cancelled: 1, confirmed: 0 });
        await page.getByRole('button', { name: 'Dismiss old prompt' }).click();
        expect(await counts(page)).toEqual({ cancelled: 1, confirmed: 0 });
    });
}
