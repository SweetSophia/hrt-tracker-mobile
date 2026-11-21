import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage, makeBundle, pasteAndImport, confirmDialog } from '../helpers';

test('imports both modes and renders bundled diagrams without a backend', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await page.goto('/');
    const bundle = makeBundle();
    bundle.calibration.method = 'ekf';
    const common = { timeH: Date.now() / 3_600_000 - 24, route: 'injection', extras: {} };
    bundle.modes.transfem.events = [{ ...common, id: 'synthetic-f', ester: 'EV', doseMG: 4 }];
    bundle.modes.transmasc.events = [{ ...common, id: 'synthetic-m', ester: 'TE', doseMG: 50 }];
    await pasteAndImport(page, JSON.stringify(bundle));
    await confirmDialog(page, 'Merge');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Backup merged.');
    await page.locator('[data-prompt="alert"]').getByRole('button', { name: 'OK', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]')[0].id)).toBe('synthetic-f');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-masc-events') ?? '[]')[0].id)).toBe(
        'synthetic-m',
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await page.getByRole('button', { name: 'Everyday security', exact: true }).click();
    const section = page.locator('#extended-network-map');
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('.opsec-mermaid svg')).toHaveCount(1, { timeout: 30_000 });
    await expect(section.locator('.opsec-mermaid-fallback')).toHaveCount(0);
});
