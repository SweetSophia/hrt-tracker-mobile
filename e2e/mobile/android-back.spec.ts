import { expect, test, type Page } from '@playwright/test';
import { baseStorage, seedStorage } from '../helpers';

type Harness = { back(): void; leaves: number; listeners(): number };
const back = (page: Page) =>
    page.evaluate(() => (window as unknown as { __backHarness: Harness }).__backHarness.back());
const leaves = (page: Page) =>
    page.evaluate(() => (window as unknown as { __backHarness: Harness }).__backHarness.leaves);

test.beforeEach(async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedStorage(
        context,
        baseStorage({
            'hrt-events': JSON.stringify([
                {
                    id: 'back-synthetic',
                    route: 'oral',
                    ester: 'EV',
                    doseMG: 2,
                    timeH: Date.now() / 3600000 - 2,
                    extras: {},
                },
            ]),
        }),
    );
    // Exercise the real bundled App adapter/React owners; this is a bridge mock, not device evidence.
    await page.addInitScript(() => {
        const callbacks = new Map<string, (event: unknown) => void>();
        let id = 0;
        const harness: Harness = {
            leaves: 0,
            listeners: () => callbacks.size,
            back: () => {
                for (const callback of callbacks.values()) callback({ canGoBack: true });
            },
        };
        Object.assign(window, {
            androidBridge: {},
            __backHarness: harness,
            Capacitor: {
                PluginHeaders: [
                    {
                        name: 'App',
                        methods: [
                            { name: 'addListener', rtype: 'callback' },
                            { name: 'removeListener', rtype: 'promise' },
                            { name: 'minimizeApp', rtype: 'promise' },
                        ],
                    },
                ],
                nativeCallback: (
                    plugin: string,
                    method: string,
                    options: { eventName: string },
                    callback: (event: unknown) => void,
                ) => {
                    if (plugin !== 'App' || method !== 'addListener' || options.eventName !== 'backButton')
                        throw new Error('Unexpected bridge call');
                    const key = String(++id);
                    callbacks.set(key, callback);
                    return key;
                },
                nativePromise: async (plugin: string, method: string, options: { callbackId: string }) => {
                    if (plugin !== 'App') throw new Error('Unexpected plugin');
                    if (method === 'removeListener') callbacks.delete(options.callbackId);
                    else if (method === 'minimizeApp') harness.leaves++;
                    else throw new Error('Unexpected method');
                },
            },
        });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __backHarness: Harness }).__backHarness.listeners()))
        .toBe(1);
});

test('wizard Back steps, cancels without writing, then leaves only at the root', async ({ page }) => {
    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    await page.getByRole('button', { name: 'Oral', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Which drug?', exact: true })).toBeVisible();
    await back(page);
    await expect(page.getByRole('button', { name: 'Oral', exact: true })).toBeVisible();
    expect(await leaves(page)).toBe(0);
    await back(page);
    await expect(page.getByRole('button', { name: 'Medication plan', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-plan') ?? '[]'))).toEqual([]);
    expect(await leaves(page)).toBe(0);
    await back(page);
    await expect.poll(() => leaves(page)).toBe(1);
});

test('nested selector closes before dose form and confirmation closes before its form', async ({ page }) => {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /2.00 mg/ }).click();
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Delete', exact: true }) });
    await expect(form).toBeVisible();
    const before = await page.evaluate(() => localStorage.getItem('hrt-events'));
    await form.locator('button[aria-haspopup="listbox"]').first().click();
    await expect(form.locator('button[aria-haspopup="listbox"]').first()).toHaveAttribute('aria-expanded', 'true');
    await back(page);
    await expect(form.locator('button[aria-haspopup="listbox"]').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    const history = await page.evaluate(() => window.history.state);
    await back(page);
    await expect(page.locator('[data-prompt="confirm"]')).toHaveCount(0);
    await expect(form).toBeVisible();
    expect(await page.evaluate(() => window.history.state)).toEqual(history);
    await back(page);
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('hrt-events'))).toBe(before);
    expect(await leaves(page)).toBe(0);
});

test('Settings category and subpage use owned history before root departure', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Data management/ }).click();
    await page.getByRole('button', { name: 'Export data', exact: true }).click();
    expect(await page.evaluate(() => window.history.state.depth)).toBe(2);
    await back(page);
    await expect(page.getByRole('button', { name: 'Export data', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.history.state.depth)).toBe(1);
    await back(page);
    await expect(page.getByRole('button', { name: /Data management/ })).toBeVisible();
    expect(await page.evaluate(() => window.history.state.depth)).toBe(0);
    expect(await leaves(page)).toBe(0);
    await back(page);
    await expect.poll(() => leaves(page)).toBe(1);
});

for (const tab of ['History', 'Labs']) {
    test(`collapsed ${tab} forms do not consume root Back`, async ({ page }) => {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await back(page);
        await expect.poll(() => leaves(page), { timeout: 2000 }).toBe(1);
    });
}

test('collapsing Supplies releases its still-open nested selector', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^General/ }).click();
    await page.getByRole('button', { name: /^Supplies(?: \d+)?$/ }).click();
    await page.getByRole('button', { name: 'Add supply', exact: true }).click();
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await expect(page.locator('button[aria-haspopup="listbox"]').first()).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Add supply', exact: true })).toBeVisible();
    await back(page);
    await expect.poll(() => page.evaluate(() => window.history.state.view), { timeout: 2000 }).toBe('settings');
    expect(await page.evaluate(() => localStorage.getItem('hrt-supplies'))).toBeNull();
    expect(await leaves(page)).toBe(0);
});

async function reloadRecords(page: Page, records: Record<string, string>) {
    await page.evaluate(storage => {
        localStorage.clear();
        for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    }, baseStorage(records));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}

test('collapsed planned doses release Back without discarding the retained draft', async ({ page }) => {
    await reloadRecords(page, {
        'hrt-events': JSON.stringify([
            {
                id: 'future-back',
                route: 'oral',
                ester: 'EV',
                doseMG: 3,
                timeH: Date.now() / 3600000 + 24,
                extras: {},
            },
        ]),
    });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const planned = page.getByRole('button', { name: /^Planned/ });
    await planned.click();
    await page.getByRole('button', { name: /3.00 mg/ }).click();
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Delete', exact: true }) });
    const dose = form.locator('input[type="number"]').first();
    await dose.fill('4');
    const selector = form.locator('button[aria-haspopup="listbox"]').first();
    await selector.click();
    await planned.click();
    await back(page);
    await expect.poll(() => leaves(page), { timeout: 2000 }).toBe(1);
    await planned.click();
    await expect(dose).toHaveValue('4');
    await expect(selector).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events')!)[0].doseMG)).toBe(3);
});

test('collapsed gel converter releases its nested selector before wizard Back', async ({ page }) => {
    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    await page.getByRole('button', { name: /^Gel/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const converter = page.getByRole('button', { name: 'Convert from the pack', exact: true });
    await converter.click();
    const body = page.locator(`[id="${await converter.getAttribute('aria-controls')}"]`);
    await body.locator('button[aria-haspopup="listbox"]').click();
    await converter.click();
    await back(page);
    await expect(page.getByRole('button', { name: /^Gel/ })).toBeVisible({ timeout: 2000 });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-plan') ?? '[]'))).toEqual([]);
});

test('collapsing a lab editor cancels its invisible delete prompt and releases Back', async ({ page }) => {
    await reloadRecords(page, {
        'hrt-lab-results': JSON.stringify([
            {
                id: 'lab-back',
                timeH: Date.now() / 3600000 - 1,
                concValue: 123,
                unit: 'pmol/l',
            },
        ]),
    });
    await page.getByRole('button', { name: 'Labs', exact: true }).click();
    const row = page.getByRole('button', { name: /123 pmol/ });
    await row.click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    await row.click();
    await expect(page.locator('[data-prompt="confirm"]')).toHaveCount(0, { timeout: 2000 });
    await back(page);
    await expect.poll(() => leaves(page)).toBe(1);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hrt-lab-results')!))).toHaveLength(1);
});

for (const kind of ['plan', 'supplies']) {
    test(`deleting the open ${kind} row releases its Back owner`, async ({ page }) => {
        const record =
            kind === 'plan'
                ? { id: 'delete-back', route: 'oral', ester: 'EV', doseMG: 2, extras: {}, everyDays: 1, timesPerDay: 1 }
                : {
                      id: 'delete-back',
                      route: 'oral',
                      ester: 'EV',
                      pack: { kind: 'pill', mg: 2 },
                      count: 20,
                      startedAt: Date.now(),
                  };
        await reloadRecords(page, { [`hrt-${kind}`]: JSON.stringify([record]) });
        if (kind === 'plan') await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
        else {
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await page.getByRole('button', { name: /^General/ }).click();
            await page.getByRole('button', { name: /^Supplies(?: \d+)?$/ }).click();
        }
        await page
            .locator('button[aria-expanded="false"]:not([aria-haspopup])')
            .filter({ hasText: /estradiol valerate/i })
            .click();
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await page.locator('[data-prompt="confirm"]').getByRole('button', { name: 'Delete', exact: true }).click();
        await expect
            .poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), `hrt-${kind}`))
            .toEqual([]);
        await back(page);
        await expect
            .poll(() => page.evaluate(() => window.history.state.view), { timeout: 2000 })
            .toBe(kind === 'plan' ? 'home' : 'settings');
        expect(await leaves(page)).toBe(0);
    });
}
