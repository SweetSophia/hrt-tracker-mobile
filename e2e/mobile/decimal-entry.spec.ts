import { expect, test, type Page } from '@playwright/test';
import { baseStorage, nowHours, seedStorage, type LabFixture } from '../helpers';

/**
 * Stage 1 decimal entry for Labs. The browser locale stays the Playwright
 * default (en-US); the application locale is set through hrt-lang, so the
 * Russian case is the one where the two disagree.
 */

test.use({ locale: 'en-US' });

const labs = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-lab-results') ?? '[]')) as Promise<LabFixture[]>;

const copy = {
    ru: {
        labs: 'Анализы',
        add: 'Добавить результат анализа',
        e2: 'Уровень эстрадиола',
        t: 'Уровень тестостерона',
        save: 'Сохранить',
    },
    en: { labs: 'Labs', add: 'Add lab result', e2: 'Estradiol level', t: 'Testosterone level', save: 'Save' },
} as const;

const openLabForm = async (page: Page, lang: keyof typeof copy) => {
    await seedStorage(page.context(), baseStorage({ 'hrt-lang': lang }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: copy[lang].labs, exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy[lang].labs, exact: true }).click();
    // The header pill and the empty-state button share the label; the pill is first.
    await page.getByRole('button', { name: copy[lang].add }).first().click();
    await expect(field(page, copy[lang].e2)).toBeVisible();
};

/** The field input, not the unit tablist that shares its accessible name. */
const field = (page: Page, name: string) => page.getByLabel(name).and(page.locator('input'));

test('Russian app with an en-US browser stores 1,5 as 1.5 with the selected unit', async ({ page }) => {
    await openLabForm(page, 'ru');
    const estradiol = field(page, copy.ru.e2);
    await estradiol.focus();
    await page.keyboard.insertText('1,5');
    await page.getByRole('button', { name: copy.ru.save, exact: true }).click();

    await expect.poll(() => labs(page)).toHaveLength(1);
    const [saved] = await labs(page);
    expect(saved.concValue).toBe(1.5);
    expect(saved.unit).toBe('pmol/l');
});

test('a dot separator stores 1.5 in the unit chosen for the field', async ({ page }) => {
    await openLabForm(page, 'en');
    const estradiol = field(page, copy.en.e2);
    await estradiol.fill('1.5');
    await page.getByRole('tab', { name: 'pg/mL', exact: true }).click();
    await page.getByRole('button', { name: copy.en.save, exact: true }).click();

    await expect.poll(() => labs(page)).toHaveLength(1);
    const [saved] = await labs(page);
    expect(saved.concValue).toBe(1.5);
    expect(saved.unit).toBe('pg/ml');
});

test('invalid text in the optional second hormone blocks the save', async ({ page }) => {
    await openLabForm(page, 'en');
    await field(page, copy.en.e2).fill('2.5');
    const testosterone = field(page, copy.en.t);
    await testosterone.focus();
    await page.keyboard.insertText('1.2,3');
    await expect(page.getByRole('button', { name: copy.en.save, exact: true })).toBeDisabled();

    expect(await labs(page)).toEqual([]);
    await expect(field(page, copy.en.t)).toBeVisible();
});

test('typing a comma prefix stays silent until the value is complete', async ({ page }) => {
    await openLabForm(page, 'ru');
    const estradiol = field(page, copy.ru.e2);
    await estradiol.focus();
    await page.keyboard.type('0,');
    await expect(estradiol).toHaveValue('0,');
    await expect(estradiol).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.field-hint.is-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy.ru.save, exact: true })).toBeDisabled();
    expect(await labs(page)).toEqual([]);

    // Leaving the field unfinished explains the disabled Save with the same
    // format hint, but only after the focused prefix was checked to be quiet.
    await estradiol.blur();
    await expect(estradiol).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.field-hint.is-error')).toContainText('1,5');

    await estradiol.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('5');
    await expect(estradiol).toHaveValue('0,5');
    await page.getByRole('button', { name: copy.ru.save, exact: true }).click();

    await expect.poll(() => labs(page)).toHaveLength(1);
    const [saved] = await labs(page);
    expect(saved.concValue).toBe(0.5);
    expect(saved.unit).toBe('pmol/l');
});

test('the alternate-unit preview formats with the app locale', async ({ page }) => {
    await openLabForm(page, 'ru');
    const estradiol = field(page, copy.ru.e2);
    // 150 pmol/L ≈ 40.9 pg/mL; ru renders the mark as a comma.
    await estradiol.pressSequentially('150');
    await expect(page.getByText('≈ 40,9 pg/mL')).toBeVisible();
});

test('an edited lab reopens with the stored value in the app locale', async ({ page, context }) => {
    const priorLab: LabFixture = { id: 'lab-ru', timeH: nowHours() - 1, concValue: 1.5, unit: 'pmol/l' };
    await seedStorage(context, baseStorage({ 'hrt-lab-results': JSON.stringify([priorLab]), 'hrt-lang': 'ru' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: copy.ru.labs, exact: true }).click();
    await page.getByRole('button', { name: /1\.5/ }).click();
    // Scope to the row's own drawer: the collapsed quick-add form shares the label.
    const drawer = page
        .locator('div')
        .filter({ has: page.getByRole('button', { name: /1\.5/, expanded: true }) })
        .last();
    await expect(drawer.getByLabel(copy.ru.e2).and(page.locator('input'))).toHaveValue('1,5');
});
