import { expect, test } from '@playwright/test';
import {
    baseStorage,
    confirmDialog,
    gotoApp,
    pasteAndImport,
    registerUser,
    seedStorage,
    signedInStorage,
    SYNTHETIC_PASSWORD,
} from './helpers';

const openWeight = async (page: import('@playwright/test').Page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: /^Weight/ }).click();
};
test('startup does not write default record arrays or model settings', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    expect(await page.evaluate(() => localStorage.getItem('hrt-events'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('hrt-plan'))).toBeNull();
});
test('failed save keeps the confirmed value and the open edit form', async ({ page, context }, testInfo) => {
    await seedStorage(context, baseStorage({ 'hrt-weight': '70' }));
    await gotoApp(page);
    await openWeight(page);
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === 'hrt-weight' && value === '72')
                throw new DOMException('Synthetic full disk', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('spinbutton')).toHaveValue('72');
    await expect(page.getByRole('alert')).toContainText('could not be saved');
    await page.screenshot({ path: testInfo.outputPath('storage-failure.png') });
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('70');
});
test('save waits for the browser storage lock before leaving the form', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-weight': '70' }));
    await gotoApp(page);
    await openWeight(page);
    await page.evaluate(() => {
        void navigator.locks.request(
            'hrt-record-store-v1',
            () =>
                new Promise<void>(resolve => {
                    (window as unknown as { releaseRecords: () => void }).releaseRecords = resolve;
                }),
        );
    });
    await expect
        .poll(() => page.evaluate(() => typeof (window as unknown as { releaseRecords?: unknown }).releaseRecords))
        .toBe('function');
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('spinbutton')).toHaveValue('72');
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('70');
    await page.evaluate(() => (window as unknown as { releaseRecords: () => void }).releaseRecords());
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('72');
});
test('startup recovery failure blocks records and can retry without replacing them', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-weight': '70', 'hrt-replace-journal-v1': '{bad' }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Could not open local records' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('70');
    // Simulate recovery becoming possible; no production bypass is provided.
    await page.evaluate(() => localStorage.removeItem('hrt-replace-journal-v1'));
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('70');
});
test('mode hydration preserves the settings page and shows the selected mode', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /HRT mode/ }).click();
    await page.getByRole('button', { name: /^Masculinizing HRT/ }).click();
    await expect(page.getByRole('button', { name: /^Masculinizing HRT/ })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('hrt-mode'))).toBe('transmasc');
    expect(await page.evaluate(() => localStorage.getItem('hrt-masc-events'))).toBeNull();
});
test('a stale tab cannot overwrite a newer committed edit', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-weight': '70' }));
    await gotoApp(page);
    const other = await context.newPage();
    await gotoApp(other);
    await openWeight(page);
    await openWeight(other);
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await other.getByRole('spinbutton').fill('73');
    await other.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(other.getByRole('alert')).toContainText('could not be saved');
    await expect(other.getByRole('spinbutton')).toHaveValue('73');
    expect(await other.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('72');
    await other.close();
});
test('a delayed save cannot navigate away from a newer page', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-weight': '70' }));
    await gotoApp(page);
    await openWeight(page);
    await page.evaluate(() => {
        void navigator.locks.request(
            'hrt-record-store-v1',
            () =>
                new Promise<void>(resolve => {
                    (window as unknown as { releaseRecords: () => void }).releaseRecords = resolve;
                }),
        );
    });
    await expect
        .poll(() => page.evaluate(() => typeof (window as unknown as { releaseRecords?: unknown }).releaseRecords))
        .toBe('function');
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Labs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lab results', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { releaseRecords: () => void }).releaseRecords());
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('72');
    await expect(page.getByRole('heading', { name: 'Lab results', exact: true })).toBeVisible();
});

test('a cancelled file import cannot poison a later cloud restore', async ({ page, context, request }) => {
    const user = await registerUser(request, 'cancel-import');
    const key = `hrt-u${user.user.id}-events`;
    const event = {
        id: 'existing',
        route: 'oral',
        ester: 'E2',
        doseMG: 2,
        timeH: Math.floor(Date.now() / 3_600_000) - 24,
        extras: {},
    };
    await seedStorage(context, signedInStorage(user, { [key]: JSON.stringify([event]) }));
    const backup = { events: [{ ...event, id: 'cloud-restored' }], weight: 80 };
    await page.route('**/api/content', route =>
        route.fulfill({ json: [{ id: 'synthetic', created_at: 1700000000, data_size: 200 }] }),
    );
    await page.route('**/api/content/synthetic', route =>
        route.fulfill({
            json: { id: 'synthetic', user_id: user.user.id, created_at: 1700000000, data: JSON.stringify(backup) },
        }),
    );
    await gotoApp(page);
    await pasteAndImport(page, JSON.stringify({ events: [{ ...event, id: 'cancelled-file' }] }));
    await confirmDialog(page, 'Keep it');
    await openWeight(page);
    await page.getByRole('spinbutton').fill('72');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.locator('[role="button"][aria-expanded="false"]').click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await confirmDialog(page, 'OK');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Imported doses successfully');
    expect(
        await page.evaluate(
            k => JSON.parse(localStorage.getItem(k) ?? '[]').map((item: { id: string }) => item.id),
            key,
        ),
    ).toEqual(['cloud-restored']);
});

for (const title of ['Edit username', 'Change password', 'Delete account']) {
    test(`session expiry leaves the ${title} page`, async ({ page, context, request }) => {
        const user = await registerUser(request, 'expired-view');
        await seedStorage(context, signedInStorage(user));
        await gotoApp(page);
        await page.getByRole('button', { name: 'Account', exact: true }).click();
        await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
        await page.evaluate(() => window.dispatchEvent(new Event('auth:unauthorized')));
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
    });
}

test('a concurrent session expiry cannot skip local cleanup after account deletion', async ({
    page,
    context,
    request,
}) => {
    const user = await registerUser(request, 'delete-records');
    const accountWeight = `hrt-u${user.user.id}-weight`;
    await seedStorage(context, signedInStorage(user, { [accountWeight]: '80', 'hrt-weight': '70' }));
    await page.route('**/api/user/me', async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await page.evaluate(() => window.dispatchEvent(new Event('auth:unauthorized')));
        await route.fulfill({ response });
    });
    await gotoApp(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: /^Delete account/ }).click();
    await expect(page.getByText(/also removes its records from this device/)).toBeVisible();
    await page.getByLabel('Enter password to confirm').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: 'Delete account', exact: true }).click();
    await expect(page.getByText(/Your account has been deleted/)).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), accountWeight)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('hrt-weight'))).toBe('70');
});

test('a failed portable preference retains its selection and displays a storage error', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Language/ }).click();
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === 'hrt-lang' && value === 'ja')
                throw new DOMException('Synthetic full disk', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await page.getByRole('button', { name: '日本語', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('could not be saved');
    await expect(page.getByRole('button', { name: 'English', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '日本語', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('hrt-lang'))).toBe('en');
});
