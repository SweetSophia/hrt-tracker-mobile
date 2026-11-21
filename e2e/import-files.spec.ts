import { expect, test } from '@playwright/test';
import {
    baseStorage,
    gotoApp,
    seedStorage,
    openImport,
    makeBundle,
    emptyMode,
    confirmDialog,
    readStorage,
    dismissAlert,
} from './helpers';

for (const action of ['Select JSON file', 'Replace this device']) {
    test(`${action} passes selected bytes to the existing validator`, async ({ page, context }) => {
        await seedStorage(context, baseStorage());
        await gotoApp(page);
        await openImport(page);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: action, exact: false }).click();
        await (
            await chooser
        ).setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad-json') });
        await expect(page.locator('[data-prompt="alert"]')).toContainText('Import failed.');
        await page.locator('[data-prompt="alert"]').getByRole('button', { name: 'OK', exact: true }).click();
        await expect(page.getByRole('button', { name: action, exact: false })).toBeEnabled();
        await expect(page.locator('input[type=file]')).toHaveCount(0);
    });
}

test('oversized file is rejected before reading and cancellation permits another pick', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await openImport(page);
    const button = page.getByRole('button', { name: 'Select JSON file', exact: false });
    let chooser = page.waitForEvent('filechooser');
    await button.click();
    await chooser;
    // Browser cancel event, including a previously empty input selection.
    await page.locator('input[type=file]').evaluate(input => input.dispatchEvent(new Event('cancel')));
    await expect(button).toBeEnabled();
    await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
    await page.evaluate(() => {
        File.prototype.stream = () => {
            throw new Error('File must not be opened');
        };
    });
    chooser = page.waitForEvent('filechooser');
    await button.click();
    await (
        await chooser
    ).setFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(16 * 1024 * 1024 + 1, 32) });
    await expect(page.locator('[data-prompt="alert"]')).toContainText('16 MiB');
});

test('selected complete backup preserves preview cancellation and replaces only after confirmation', async ({
    page,
    context,
}) => {
    const event = {
        id: 'old-synthetic',
        route: 'injection',
        ester: 'EV',
        doseMG: 1,
        timeH: Date.now() / 3600000 - 24,
        extras: {},
    };
    await seedStorage(context, baseStorage({ 'hrt-events': JSON.stringify([event]) }));
    const backup = makeBundle({
        modes: { transfem: { ...emptyMode(), events: [{ ...event, id: 'new-synthetic' }] }, transmasc: emptyMode() },
    });
    await gotoApp(page);
    await openImport(page);
    const pick = async () => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Replace this device from a complete backup', exact: false }).click();
        await (
            await chooser
        ).setFiles({
            name: 'complete.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(backup)),
        });
    };
    await pick();
    await expect(page.locator('[data-prompt="confirm"]')).toContainText('Replace this device from a complete backup?');
    await confirmDialog(page, 'Keep it');
    expect(await readStorage(page, 'hrt-events')).toEqual([event]);
    await pick();
    await confirmDialog(page, 'Replace everything');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Complete backup restored.');
    await dismissAlert(page);
    expect((await readStorage<{ id: string }[]>(page, 'hrt-events'))?.map(item => item.id)).toEqual(['new-synthetic']);
    await page.reload();
    expect((await readStorage<{ id: string }[]>(page, 'hrt-events'))?.map(item => item.id)).toEqual(['new-synthetic']);
});

for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    for (const action of ['Select JSON file', 'Replace this device from a complete backup']) {
        test(`${action} accepts ${encoding} BOM bytes like FileReader`, async ({ page, context }) => {
            await seedStorage(context, baseStorage());
            await gotoApp(page);
            await openImport(page);
            const text = JSON.stringify(makeBundle());
            const bytes = Buffer.from('\ufeff' + text, 'utf16le');
            if (encoding === 'utf-16be') bytes.swap16();
            // Compare against the browser's previous API instead of assuming its encoding behavior.
            expect(
                await page.evaluate(
                    (data: number[]) =>
                        new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onerror = () => reject(new Error('Reference read failed'));
                            reader.onload = () => resolve(reader.result as string);
                            reader.readAsText(
                                new File([new Uint8Array(data)], 'backup.json', { type: 'application/json' }),
                            );
                        }),
                    Array.from(bytes as Uint8Array),
                ),
            ).toBe(text);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', { name: action, exact: false }).click();
            await (await chooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
            await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
            await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('button', { name: action, exact: false })).toBeEnabled();
        });
    }
}

test('file and paste import actions share one pending confirmation guard', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    await openImport(page);
    await page.getByRole('button', { name: /Paste JSON text/ }).click();
    const box = page.getByPlaceholder('Paste JSON content here...');
    await box.fill('{bad-json');
    const chooser = page.waitForEvent('filechooser');
    const file = page.getByRole('button', { name: 'Replace this device from a complete backup', exact: false });
    await file.click();
    await (
        await chooser
    ).setFiles({
        name: 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(makeBundle())),
    });
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    for (const name of ['Import', 'Replace device'])
        await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await confirmDialog(page, 'Keep it');
    await expect(file).toBeEnabled();
    await expect(box).toHaveValue('{bad-json');
    const pasted = JSON.stringify(makeBundle());
    await box.fill(pasted);
    await page.getByRole('button', { name: 'Replace device', exact: true }).click();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    await expect(file).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Select JSON file', exact: false })).toBeDisabled();
    await confirmDialog(page, 'Keep it');
    await expect(file).toBeEnabled();
    await expect(box).toHaveValue(pasted);
});
