import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseStorage, gotoApp, nowHours, seedStorage, type DoseEventFixture } from '../helpers';

const storedEvents = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]')) as Promise<DoseEventFixture[]>;

async function openAddDose(page: Page) {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Add dose', exact: true }).first().click();
    return page.locator('.disclosure[data-open="true"] form');
}

async function enterText(page: Page, input: Locator, text: string) {
    await input.fill('');
    await input.focus();
    await page.keyboard.insertText(text);
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
});

test('manual dose entry stores a comma decimal at its entered precision', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    const form = await openAddDose(page);

    await enterText(page, form.getByLabel('Dose (mg)', { exact: true }), '0,0375');
    await form.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await storedEvents(page))[0]?.doseMG).toBe(0.0375);
});

test('Russian dose entry accepts a comma keystroke and shows the exact quick dose', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-lang': 'ru' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'История', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить дозу', exact: true }).first().click();
    const form = page.locator('.disclosure[data-open="true"] form');
    const amount = form.getByRole('textbox', { name: 'Доза (мг)', exact: true });

    await amount.focus();
    await page.keyboard.type('0,');
    await expect(amount).toHaveValue('0,');
    await expect(amount).not.toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByRole('alert')).toHaveCount(0);
    await page.keyboard.type('0375');
    await expect(amount).toHaveValue('0,0375');
    await form.getByRole('button', { name: 'Сохранить текущую дозу как быструю' }).click();
    const quickDose = form.getByRole('button', { name: '0,0375 mg', exact: true });
    await expect(quickDose).toBeVisible();
    await amount.clear();
    await quickDose.click();
    await expect(amount).toHaveValue('0,0375');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).click();

    await expect.poll(async () => (await storedEvents(page))[0]?.doseMG).toBe(0.0375);
});

test('saving an edited dose preserves a previously stored amount beyond three decimal places', async ({
    page,
    context,
}) => {
    const priorDose: DoseEventFixture = {
        id: 'fractional-dose',
        route: 'sublingual',
        ester: 'EV',
        doseMG: 0.0375,
        timeH: nowHours() - 1,
        extras: {},
    };
    await seedStorage(context, baseStorage({ 'hrt-events': JSON.stringify([priorDose]) }));
    await gotoApp(page);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const row = page.locator('[data-event-id="fractional-dose"]');
    await row.getByRole('button', { name: /Estradiol valerate/ }).click();

    const form = row.locator('form');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await storedEvents(page)).toMatchObject([{ id: 'fractional-dose', doseMG: 0.0375 }]);
});

test('patch batch uses the parsed rate, wear duration, and interval', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await gotoApp(page);
    const form = await openAddDose(page);

    await form.getByRole('button', { name: /^Route / }).click();
    await form.getByRole('listbox', { name: 'Route' }).getByRole('option', { name: 'Patch apply' }).click();
    await enterText(page, form.getByLabel('Rate (µg/day)', { exact: true }), '37,5');
    const wear = form.getByLabel('Wear duration (days)', { exact: true });
    const save = form.getByRole('button', { name: 'Save', exact: true });
    await enterText(page, wear, '1.2,3');
    await expect(wear).toHaveAttribute('aria-invalid', 'true');
    await save.click();
    expect(await storedEvents(page)).toHaveLength(0);
    await wear.fill('3,');
    await expect(wear).not.toHaveAttribute('aria-invalid', 'true');
    await save.click();
    await expect(wear).toHaveAttribute('aria-invalid', 'true');
    expect(await storedEvents(page)).toHaveLength(0);
    await enterText(page, wear, '3,5');

    await page.getByRole('switch', { name: 'Batch add' }).click();
    const interval = page.getByRole('spinbutton', { name: 'Interval (days)' });
    await enterText(page, interval, '1,');
    await expect(interval).not.toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();
    await expect(save).toHaveAccessibleDescription('Check the batch interval and count before saving.');
    await interval.pressSequentially('5');

    const count = page.getByRole('spinbutton', { name: 'Count' });
    await enterText(page, count, '1,234');
    await expect(count).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();
    expect(await storedEvents(page)).toHaveLength(0);
    await count.fill('2.9');
    await expect(page.getByText(/one entry every 1\.5 days, 2 entries total/)).toBeVisible();
    await count.fill('3');
    await count.press('ArrowDown');
    await expect(count).toHaveValue('2');
    await save.click();

    await expect.poll(async () => (await storedEvents(page)).length).toBe(2);
    const events = (await storedEvents(page)).sort((a, b) => a.timeH - b.timeH);
    expect(events.map(event => event.extras)).toMatchObject([
        { releaseRateUGPerDay: 37.5, patchWearH: 84 },
        { releaseRateUGPerDay: 37.5, patchWearH: 84 },
    ]);
    expect(events[1].timeH - events[0].timeH).toBeCloseTo(36);
});
