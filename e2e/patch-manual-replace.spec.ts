import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

interface StoredEvent {
    id: string;
    route: string;
    ester: string;
    doseMG: number;
    timeH: number;
    extras: Record<string, number>;
    patchApplicationId?: string;
}

const readEvents = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]')) as Promise<StoredEvent[]>;

async function openQuickAdd(page: Page) {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Add dose', exact: true }).first().click();
}

async function selectRoute(form: Locator, label: string) {
    await form.getByRole('button', { name: /^Route / }).click();
    await form
        .getByRole('listbox', { name: 'Route', exact: true })
        .getByRole('option', { name: label, exact: true })
        .click();
}

test.describe('manual patch replace (L3 browser)', () => {
    test('batch add of three opted-in patches yields five rows and retires the older patches in pairs', async ({
        page,
        context,
    }) => {
        await seedStorage(context, baseStorage());
        await gotoApp(page);
        await openQuickAdd(page);
        const form = page.locator('.disclosure[data-open="true"] form');

        await selectRoute(form, 'Patch apply');
        // Wear stays blank: the patch runs until the next one replaces it.
        await form.getByLabel('Rate (µg/day)').fill('100');

        const replace = form.getByRole('switch', { name: 'Replace previous patch' });
        await expect(replace).toBeVisible();
        await expect(replace).toHaveAttribute('aria-checked', 'false');
        await page.getByRole('switch', { name: 'Batch add' }).click();
        await page.getByLabel('Interval (days)', { exact: true }).fill('3');
        await page.getByLabel('Count', { exact: true }).fill('3');

        await replace.click();
        await expect(replace).toHaveAttribute('aria-checked', 'true');
        await form.getByRole('button', { name: 'Save', exact: true }).click();

        await expect.poll(async () => (await readEvents(page)).length).toBe(5);
        const events = await readEvents(page);
        const applies = events.filter(e => e.route === 'patchApply').sort((a, b) => a.timeH - b.timeH);
        const removals = events.filter(e => e.route === 'patchRemove');
        expect(applies).toHaveLength(3);
        expect(removals).toHaveLength(2);
        // Three applies at three-day intervals from the chosen time.
        expect(Math.abs(applies[1].timeH - applies[0].timeH - 72)).toBeLessThan(1);
        expect(Math.abs(applies[2].timeH - applies[1].timeH - 72)).toBeLessThan(1);
        for (const apply of applies) {
            expect(apply.extras.releaseRateUGPerDay).toBe(100);
            expect(apply.extras.patchWearH).toBeUndefined();
        }
        // The first patch has nothing before it, so only the application is
        // recorded. Each later apply retires the oldest patch still worn, at
        // the moment the new one goes on.
        expect(removals.map(r => r.timeH).sort((a, b) => a - b)).toEqual([applies[1].timeH, applies[2].timeH]);
        const appliesById = new Map(applies.map(a => [a.id, a]));
        expect(removals.map(r => r.patchApplicationId).sort()).toEqual([applies[0].id, applies[1].id].sort());
        for (const removal of removals) {
            const replaced = appliesById.get(removal.patchApplicationId!);
            expect(replaced).toBeTruthy();
            expect(replaced!.timeH).toBeLessThan(removal.timeH);
        }
    });

    test('editing a removal keeps its patch pairing only while it stays a removal', async ({ page, context }) => {
        const prior = {
            id: 'prior-patch',
            route: 'patchApply',
            ester: 'E2',
            doseMG: 0,
            extras: { releaseRateUGPerDay: 100 },
            timeH: Math.floor(Date.now() / 3_600_000) - 96,
        };
        const removal = {
            id: 'prior-removal',
            route: 'patchRemove',
            ester: 'E2',
            doseMG: 0,
            extras: {},
            timeH: Math.floor(Date.now() / 3_600_000) - 72,
            patchApplicationId: 'prior-patch',
        };
        await seedStorage(context, baseStorage({ 'hrt-events': JSON.stringify([prior, removal]) }));
        await gotoApp(page);
        await page.getByRole('button', { name: 'History', exact: true }).click();
        const row = page.locator('[data-event-id="prior-removal"]').getByRole('button', { name: /^Patch remove\b/i });
        const form = page.locator('[data-event-id="prior-removal"] form');
        const formSave = form.getByRole('button', { name: 'Save', exact: true });

        // The opt-in does not exist in an edit, and a saved edit that stays a
        // removal keeps the removal paired with the patch it ended.
        await row.click();
        await expect(form.getByRole('switch', { name: 'Replace previous patch' })).toHaveCount(0);
        await formSave.click();
        await expect(form).toHaveCount(0);
        await expect
            .poll(async () => (await readEvents(page)).find(e => e.id === 'prior-removal')?.patchApplicationId)
            .toBe('prior-patch');

        // Converting the edit to another route leaves nothing to pair.
        await row.click();
        await selectRoute(form, 'Oral');
        await form.getByLabel('E2 equivalent (mg)').fill('2');
        await formSave.click();
        await expect(form).toHaveCount(0);
        await expect.poll(async () => (await readEvents(page)).find(e => e.id === 'prior-removal')?.route).toBe('oral');
        expect((await readEvents(page)).find(e => e.id === 'prior-removal')?.patchApplicationId).toBeUndefined();
    });
});
