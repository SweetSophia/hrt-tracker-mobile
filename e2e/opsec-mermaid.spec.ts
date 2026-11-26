import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage } from './helpers';

const CASES = [
    { lang: 'zh', settings: '设置', about: '关于', opsec: '日常操作与安全' },
    { lang: 'en', settings: 'Settings', about: 'About', opsec: 'Everyday security' },
] as const;

const DIAGRAMS = [
    { id: 'extended-protocols', count: 3 },
    { id: 'extended-irc', count: 2 },
    { id: 'extended-network-map', count: 1 },
    { id: 'extended-messaging', count: 1 },
    { id: 'extended-tor', count: 1 },
] as const;

for (const testCase of CASES) {
    test(`OpSec diagrams render as SVG (${testCase.lang})`, async ({ page, context }) => {
        await seedStorage(context, baseStorage({ 'hrt-lang': testCase.lang }));
        await page.goto('/');

        await page.getByRole('button', { name: testCase.settings, exact: true }).click();
        await page.getByRole('tab', { name: testCase.about, exact: true }).click();
        await page.getByRole('button', { name: testCase.opsec, exact: true }).click();

        for (const diagram of DIAGRAMS) {
            const section = page.locator(`#${diagram.id}`);
            await expect(section).toBeVisible();
            await section.scrollIntoViewIfNeeded();

            await expect(section.locator('.opsec-mermaid svg')).toHaveCount(diagram.count, { timeout: 30_000 });
            await expect(section.locator('.opsec-mermaid-fallback')).toHaveCount(0);
        }
    });
}

test('the German OpSec heading stays localized when the English guide loads', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-lang': 'de' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await page.getByRole('tab', { name: 'Über', exact: true }).click();
    await page.getByRole('button', { name: 'Alltagssicherheit', exact: true }).click();

    const guide = page.locator('[lang="en"]').filter({ has: page.locator('article.opsec-prose') });
    await expect(guide).toBeVisible();
    const marker = page.getByText('Englische Fassung', { exact: true });
    await expect(marker).toBeVisible();
    // The marker stays outside the English body so screen readers announce
    // it in German before the English guide.
    await expect(guide.getByText('Englische Fassung')).toHaveCount(0);
    expect(
        await marker.evaluate(el => {
            const article = document.querySelector('[lang="en"] article.opsec-prose');
            return !!article && !!(el.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING);
        }),
    ).toBe(true);
    await expect(page.getByText('Alltagssicherheit', { exact: true })).toBeVisible();
});
