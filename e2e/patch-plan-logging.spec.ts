import { expect, test } from '@playwright/test';
import { baseStorage, gotoApp, seedStorage } from './helpers';

test('Overview logs a patch change at the tap time and undo restores the previous patch', async ({ page, context }) => {
    const prior = {
        id: 'previous',
        route: 'patchApply',
        ester: 'E2',
        doseMG: 0,
        extras: { releaseRateUGPerDay: 100 },
        timeH: Date.now() / 3_600_000 - 72,
    };
    const plan = {
        id: 'rotation',
        route: prior.route,
        ester: prior.ester,
        doseMG: 0,
        extras: prior.extras,
        everyDays: 3,
        timesPerDay: 1,
    };
    await seedStorage(
        context,
        baseStorage({ 'hrt-events': JSON.stringify([prior]), 'hrt-plan': JSON.stringify([plan]) }),
    );
    await gotoApp(page);
    const events = () => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events')!) as (typeof prior)[]);
    const done = page.getByRole('button', { name: 'Done', exact: true });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await done.click();
    await expect.poll(async () => (await events()).map(e => e.route)).toEqual(['patchApply', 'patchApply']);
    await undo.click();
    await expect.poll(events).toEqual([prior]);

    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    await page.getByRole('button', { name: /patch/i, expanded: false }).click();
    const replace = page.getByRole('switch', { name: 'Replace previous patch' });
    await expect(replace).not.toBeChecked();
    await replace.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hrt-plan')!)[0]))
        .toEqual({
            ...plan,
            replacePreviousPatch: true,
        });
    await page.getByRole('button', { name: /Medication plan.*Back/ }).click();
    await page.reload();
    await done.click();
    await expect.poll(async () => (await events()).length).toBe(3);
    const records = await events();
    const replacement = records.find(e => e.route === 'patchApply' && e.id !== prior.id)!;
    expect(records.find(e => e.route === 'patchRemove')).toMatchObject({
        timeH: replacement.timeH,
        patchApplicationId: prior.id,
    });
    await undo.click();
    await expect.poll(events).toEqual([prior]);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    expect(await events()).toEqual([prior]);
});

test('History can edit a removal logged by a testosterone patch plan', async ({ page, context }) => {
    const timeH = Math.floor(Date.now() / 3_600_000) - 1;
    const previous = {
        id: 'old-t',
        route: 'patchApply',
        ester: 'T',
        doseMG: 0,
        timeH: timeH - 72,
        extras: { releaseRateUGPerDay: 100 },
    };
    const removal = {
        id: 'removed-t',
        route: 'patchRemove',
        ester: 'T',
        doseMG: 0,
        timeH,
        extras: {},
        patchApplicationId: previous.id,
    };
    await seedStorage(
        context,
        baseStorage({ 'hrt-mode': 'transmasc', 'hrt-masc-events': JSON.stringify([previous, removal]) }),
    );
    await gotoApp(page);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const row = page.locator('[data-event-id="removed-t"]');
    await row.getByRole('button', { name: /Patch remove/i }).click();
    await expect(row.getByRole('button', { name: 'Route Patch remove', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const events = await page.evaluate(
        () => JSON.parse(localStorage.getItem('hrt-masc-events')!) as (typeof removal)[],
    );
    expect(events.find(e => e.id === removal.id)).toMatchObject(removal);
});
