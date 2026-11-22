import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { baseStorage, seedStorage } from '../helpers';

/** Throws exactly once for the 'hrt-mode' key, like a failing write. */
const failFirstModeWrite = (context: BrowserContext) =>
    context.addInitScript(() => {
        const setItem = Storage.prototype.setItem;
        let tripped = false;
        Storage.prototype.setItem = function (key: string, value: string) {
            if (key === 'hrt-mode' && !tripped) {
                tripped = true;
                throw new DOMException('Synthetic one-time hrt-mode write failure', 'AbortError');
            }
            return setItem.call(this, key, value);
        };
    });

const freshIntro = async (page: Page): Promise<void> => {
    await expect(page.getByRole('heading', { name: 'Hello there' })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What are you tracking?' })).toBeVisible();
};

test('a failed mode write holds the exit until retried, and Back keeps the retry reachable', async ({
    page,
    context,
}) => {
    await seedStorage(context, baseStorage({ 'app-onboarded': 'false' }));
    await failFirstModeWrite(context);
    await page.goto('/');
    await freshIntro(page);

    await page.getByRole('button', { name: /Masculinizing HRT/ }).click();
    expect(await page.evaluate(() => localStorage.getItem('hrt-mode'))).toBeNull();

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What are you tracking?' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How it works' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What are you tracking?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Hello there' })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What are you tracking?' })).toBeVisible();

    const alert = page.getByRole('alert');
    await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-mode'))).toBe('transmasc');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
});

test('rapid retaps land the last choice, and Next advances once it is saved', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'app-onboarded': 'false' }));
    await page.goto('/');
    await freshIntro(page);

    await page.getByRole('button', { name: /Feminizing HRT/ }).click();
    await page.getByRole('button', { name: /Masculinizing HRT/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-mode'))).toBe('transmasc');
});
