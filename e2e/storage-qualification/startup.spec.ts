import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

test('reloading without the native bridge keeps edits blocked and preserves existing browser records', async ({
    page,
}) => {
    const synthetic = '[{"id":"synthetic-browser-record"}]';
    await page.route('**/__startup-seed', route =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    );
    await page.goto('/__startup-seed');
    await page.evaluate(value => localStorage.setItem('hrt-events', value), synthetic);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Could not open local records' })).toBeVisible();
    await expect(page.getByText(/do not uninstall this app or clear its storage/i)).toBeVisible();
    await expect(page.getByText(/keep any backups you exported/i)).toBeVisible();
    await expect(page.getByText(/separate, empty installation of a compatible version of this app/i)).toBeVisible();
    await expect(page.getByText(/stay offline and signed out while you restore and verify/i)).toBeVisible();
    await expect(page.locator('#root input, #root textarea, #root form')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(1);
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'hrt-events': synthetic });
    expect(await page.evaluate(() => '__hrtStorageQualification' in window)).toBe(false);
    await Promise.all([
        page.waitForEvent('domcontentloaded'),
        page.getByRole('button', { name: 'Reload', exact: true }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Could not open local records' })).toBeVisible();
    await expect(page.locator('#root input, #root textarea, #root form')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(1);
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'hrt-events': synthetic });
});

test.describe('device language before record preferences load', () => {
    test.use({ locale: 'zh-Hant-TW' });

    test('shows the startup guidance in Traditional Chinese', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: '無法開啟本機記錄' })).toBeVisible();
        await expect(page.getByText(/請勿移除此 App 或清除它的儲存空間/)).toBeVisible();
        await expect(page.getByText(/保留已匯出的備份/)).toBeVisible();
        await expect(page.getByText(/另外安裝此 App 的相容版本，並確認該安裝沒有任何既有資料/)).toBeVisible();
        await expect(page.getByText(/還原備份並核對記錄期間，請保持離線且不要登入/)).toBeVisible();
        await expect(page.getByRole('main')).toHaveAttribute('lang', 'zh-TW');
        await expect(page.getByRole('button', { name: '重新載入', exact: true })).toBeVisible();
    });
});

test('selects the first supported device language', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'language', { value: 'fr-FR' });
        Object.defineProperty(navigator, 'languages', { value: ['fr-FR', 'uk-UA', 'en-US'] });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Не вдалося відкрити локальні записи' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveAttribute('lang', 'uk');
});
