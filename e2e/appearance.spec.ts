import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

async function openAppearance(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Appearance/ }).click();
}

function accent(page: Page) {
    return page.locator('html').evaluate(root => getComputedStyle(root).getPropertyValue('--accent').trim());
}

function stroke(curve: Locator) {
    return curve.evaluate(path => getComputedStyle(path).stroke);
}

test('the selected color theme follows System and survives reopening the app', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await openAppearance(page);

    const system = page.getByRole('button', { name: 'System', exact: true });
    const terracotta = page.getByRole('button', { name: 'Terracotta', exact: true });
    const plum = page.getByRole('button', { name: 'Plum', exact: true });
    await expect(system).toHaveAttribute('aria-pressed', 'true');
    await expect(terracotta).toHaveAttribute('aria-pressed', 'true');
    const lightTerracotta = await accent(page);

    await plum.click();
    await expect(plum).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => accent(page)).not.toBe(lightTerracotta);
    const lightPlum = await accent(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect.poll(() => accent(page)).not.toBe(lightPlum);
    const darkPlum = await accent(page);
    await expect(system).toHaveAttribute('aria-pressed', 'true');
    await expect(plum).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect.poll(() => accent(page)).toBe(darkPlum);
    await openAppearance(page);
    await expect(plum).toHaveAttribute('aria-pressed', 'true');
});

test('Black & white keeps its legacy look and remembers the last color theme', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'app-theme': 'mono' }));
    await gotoApp(page);
    await openAppearance(page);

    const mono = page.getByRole('button', { name: 'Black & white', exact: true });
    const teal = page.getByRole('button', { name: 'Teal', exact: true });
    const root = page.locator('html');
    await expect(mono).toHaveAttribute('aria-pressed', 'true');
    await expect(root).toHaveCSS('filter', 'grayscale(1)');
    await expect(teal).toBeDisabled();
    const monoAccent = await accent(page);

    const light = page.getByRole('button', { name: 'Light', exact: true });
    await light.click();
    await expect(teal).toBeEnabled();
    await teal.click();
    await expect(teal).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => accent(page)).not.toBe(monoAccent);
    const tealAccent = await accent(page);

    await mono.click();
    await expect(root).toHaveCSS('filter', 'grayscale(1)');
    await expect.poll(() => accent(page)).toBe(monoAccent);

    await light.click();
    await expect(teal).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => accent(page)).toBe(tealAccent);
});

test('a color theme recolors the main trends while the comparison series keeps its color', async ({
    page,
    context,
}) => {
    const timeH = Math.floor(Date.now() / 3_600_000) - 24;
    const events = [
        { id: 'theme-primary', route: 'oral', ester: 'E2', doseMG: 2, timeH, extras: {} },
        { id: 'theme-comparison', route: 'oral', ester: 'CPA', doseMG: 12, timeH, extras: {} },
    ];
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(context, baseStorage({ 'hrt-weight': '70', 'hrt-events': JSON.stringify(events) }));
    await gotoApp(page);

    const primary = page.locator('svg g[clip-path^="url(#clip-p-"] > path').first();
    const comparison = page.locator('svg g[clip-path^="url(#clip-s-"] > path').first();
    const terracotta = await stroke(primary);
    const comparisonColor = await stroke(comparison);

    await openAppearance(page);
    const plum = page.getByRole('button', { name: 'Plum', exact: true });
    await plum.click();
    await expect(plum).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const lightPlum = await stroke(primary);
    expect(lightPlum).not.toBe(terracotta);
    expect(await stroke(comparison)).toBe(comparisonColor);

    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    const forecast = page.locator('svg[role="img"] path[stroke-width="2"]').first();
    expect(await stroke(forecast)).toBe(lightPlum);
});
